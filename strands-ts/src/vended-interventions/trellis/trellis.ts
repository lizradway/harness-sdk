import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny } from '../../interventions/actions.js'
import type { InterventionAction } from '../../interventions/actions.js'
import type { BeforeToolCallEvent, AfterToolCallEvent } from '../../hooks/events.js'
import type { OnError } from '../../interventions/handler.js'
import type { Proceed, Transform } from '../../interventions/actions.js'

/**
 * A temporal constraint in compiled form. Each variant maps to a Dogwood policy
 * compiled down to a trivial check (set membership or counter comparison).
 *
 * @see {@link https://github.com/dogwood-policy/dogwood | Dogwood Policy Language}
 */
export type Constraint =
  | ForbidConstraint
  | RequiresConstraint
  | LoopConstraint
  | CascadeConstraint
  | BudgetConstraint

/**
 * Stateless authorization: tool is unconditionally forbidden.
 * Equivalent to `forbid(principal, action == Action::"X", resource)`.
 */
export interface ForbidConstraint {
  type: 'forbid'
  tool: string
  principal?: string
  resource?: string
}

/**
 * Prerequisite: tool B requires tool A to have completed successfully first.
 * Equivalent to `forbid ... unless temporal { formerly Action::"A"::request }`.
 */
export interface RequiresConstraint {
  type: 'requires'
  tool: string
  condition: string
}

/**
 * Loop detection: block repeated identical calls beyond a threshold.
 * Equivalent to `forbid ... when temporal { count(same input) >= N }`.
 */
export interface LoopConstraint {
  type: 'loop'
  tool: string
  maxRepeats: number
}

/**
 * Cascade: when a trigger tool fails, block dependent tools.
 * Equivalent to `forbid ... when temporal { formerly trigger::resolution{error} }`.
 */
export interface CascadeConstraint {
  type: 'cascade'
  trigger: string
  blocks: string[]
}

/**
 * Budget: cap total calls to a tool per session.
 * Equivalent to `forbid ... when temporal { count(...) >= N }`.
 */
export interface BudgetConstraint {
  type: 'budget'
  tool: string
  maxCalls: number
}

/**
 * Evidence accumulated for a candidate constraint before it can enforce.
 */
export interface ConstraintEvidence {
  failures: number
  successes: number
  overrides: number
}

/**
 * A constraint with its evidence and enforcement status.
 */
export interface ConstraintRecord {
  constraint: Constraint
  evidence: ConstraintEvidence
  status: 'candidate' | 'enforcing' | 'advisory' | 'retired'
  source: 'authored' | 'discovered'
}

/**
 * Storage interface for persisting mined constraints across agents.
 */
export interface TrellisStorage {
  load(): Promise<ConstraintRecord[]>
  save(records: ConstraintRecord[]): Promise<void>
}

/**
 * In-memory storage for single-process use. Does not survive restarts.
 */
export class InMemoryTrellisStorage implements TrellisStorage {
  private _records: ConstraintRecord[] = []

  async load(): Promise<ConstraintRecord[]> {
    return [...this._records]
  }

  async save(records: ConstraintRecord[]): Promise<void> {
    this._records = [...records]
  }
}

/**
 * Configuration for the {@link Trellis} intervention handler.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood | Dogwood Policy Language}
 */
export interface TrellisConfig {
  /** Dogwood policy text — the authoring surface for temporal constraints. Requires a Dogwood parser. */
  policies?: string

  /** Compiled constraints in typed JSON form — programmatic escape hatch when a parser isn't available. */
  compiledConstraints?: Constraint[]

  /** Enable constraint mining from observed failure patterns. */
  discover?: boolean

  /** Minimum failure count before a mined constraint can enforce. Default: 3. */
  minEvidence?: number

  /** Storage backend for persisting mined constraints across agents. */
  storage?: TrellisStorage

  /**
   * Error handling: `'throw'` (default), `'deny'` (fail-closed), `'proceed'` (fail-open).
   */
  onError?: OnError
}

/**
 * Execution trajectory tracked during a single agent invocation.
 *
 * @internal
 */
interface Trajectory {
  completed: Set<string>
  callCounts: Map<string, number>
  failed: Set<string>
  inputHashes: Map<string, Map<string, number>>
}

/**
 * A single observation of a tool call outcome.
 *
 * @internal
 */
interface Observation {
  tool: string
  inputHash: string
  success: boolean
  precedingTools: string[]
}

/**
 * Trellis: Dogwood temporal constraint mining intervention handler.
 *
 * A wooden framework that guides agent growth — mines temporal constraints from
 * observed execution patterns and enforces them deterministically. Like a garden
 * trellis shapes what grows through it, Trellis shapes agent behavior by learning
 * from failures and preventing their recurrence.
 *
 * Evaluates compiled Dogwood temporal constraints against the agent's execution
 * trajectory on every `beforeToolCall`. Records tool outcomes on `afterToolCall`
 * to advance the trajectory state.
 *
 * When `discover: true`, the handler mines constraint patterns from failures
 * automatically. Mined constraints enforce within the same session once evidence
 * thresholds are met.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood | Dogwood Policy Language}
 *
 * @example
 * ```typescript
 * // Mining enabled — zero-config, learns from execution
 * const trellis = new Trellis({
 *   discover: true,
 *   storage: new InMemoryTrellisStorage(),
 * })
 *
 * // Authored policies (when Dogwood parser is available)
 * const trellis = new Trellis({
 *   policies: `
 *     forbid(principal, action == Action::"charge", resource)
 *     unless temporal { formerly Action::"authenticate"::request };
 *   `,
 * })
 *
 * const agent = new Agent({
 *   tools: [authenticate, charge, deploy, promote],
 *   interventions: [trellis],
 * })
 * ```
 */
export class Trellis extends InterventionHandler {
  readonly name = 'trellis'
  override readonly onError: OnError

  private readonly _records: ConstraintRecord[]
  private readonly _discover: boolean
  private readonly _minEvidence: number
  private readonly _storage: TrellisStorage | undefined
  private _trajectory: Trajectory
  private readonly _observations: Observation[] = []
  private readonly _toolSequence: string[] = []
  private _loaded = false

  constructor(config: TrellisConfig) {
    super()
    this.onError = config.onError ?? 'throw'
    this._discover = config.discover ?? false
    this._minEvidence = config.minEvidence ?? 3
    this._storage = config.storage
    this._trajectory = createTrajectory()

    if (config.policies) {
      throw new Error(
        'Dogwood policy text requires a parser (WASM module). ' +
        'Use compiledConstraints for now, or provide a parser when available.'
      )
    }

    this._records = (config.compiledConstraints ?? []).map((constraint) => ({
      constraint,
      evidence: { failures: 0, successes: 0, overrides: 0 },
      status: 'enforcing' as const,
      source: 'authored' as const,
    }))
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    await this._ensureLoaded()

    const toolName = event.toolUse.name
    const inputHash = hashInput(event.toolUse.input)

    for (const record of this._records) {
      if (record.status !== 'enforcing') continue
      const violation = this._evaluate(record.constraint, toolName, inputHash)
      if (violation) {
        return deny(violation)
      }
    }

    return proceed()
  }

  override async afterToolCall(event: AfterToolCallEvent): Promise<Proceed | Transform> {
    const toolName = event.toolUse.name
    const inputHash = hashInput(event.toolUse.input)
    const failed = !!(event.error || event.result.status === 'error')

    if (failed) {
      this._trajectory.failed.add(toolName)
    } else {
      this._trajectory.completed.add(toolName)
    }

    const count = (this._trajectory.callCounts.get(toolName) ?? 0) + 1
    this._trajectory.callCounts.set(toolName, count)

    const toolInputs = this._trajectory.inputHashes.get(toolName) ?? new Map<string, number>()
    const repeatCount = (toolInputs.get(inputHash) ?? 0) + 1
    toolInputs.set(inputHash, repeatCount)
    this._trajectory.inputHashes.set(toolName, toolInputs)

    if (this._discover) {
      this._observations.push({
        tool: toolName,
        inputHash,
        success: !failed,
        precedingTools: [...this._toolSequence],
      })
      this._toolSequence.push(toolName)
      this._detectPatterns(toolName, failed)
    }

    return proceed()
  }

  /** Returns all constraint records (authored + mined). */
  getConstraintRecords(): ReadonlyArray<ConstraintRecord> {
    return this._records
  }

  /** Returns only actively enforcing constraints. */
  getEnforcingConstraints(): ReadonlyArray<ConstraintRecord> {
    return this._records.filter((record) => record.status === 'enforcing')
  }

  /** Resets the trajectory state. Call between invocations if reusing the handler. */
  resetTrajectory(): void {
    this._trajectory = createTrajectory()
    this._toolSequence.length = 0
  }

  /** Persists current constraint records to storage. */
  async persist(): Promise<void> {
    if (this._storage) {
      await this._storage.save([...this._records])
    }
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded || !this._storage) return
    this._loaded = true
    const stored = await this._storage.load()
    for (const record of stored) {
      if (!this._hasConstraint(record.constraint)) {
        this._records.push(record)
      }
    }
  }

  private _hasConstraint(constraint: Constraint): boolean {
    return this._records.some((record) => constraintKey(record.constraint) === constraintKey(constraint))
  }

  private _detectPatterns(toolName: string, failed: boolean): void {
    if (failed) {
      this._detectCascadeCandidate(toolName)
    } else {
      this._detectPrerequisiteFromSuccess(toolName)
    }
    this._detectBudgetCandidate(toolName)
    this._detectLoopCandidate(toolName)
  }

  private _detectPrerequisiteFromSuccess(successTool: string): void {
    const failureObs = this._observations.filter(
      (obs) => obs.tool === successTool && !obs.success
    )
    const successObs = this._observations.filter(
      (obs) => obs.tool === successTool && obs.success
    )

    if (failureObs.length < this._minEvidence || successObs.length === 0) return

    const potentialPrereqs = new Set<string>()
    for (const success of successObs) {
      for (const preceding of success.precedingTools) {
        if (preceding !== successTool) {
          potentialPrereqs.add(preceding)
        }
      }
    }

    for (const prereq of potentialPrereqs) {
      const failuresWithout = failureObs.filter(
        (obs) => !obs.precedingTools.includes(prereq)
      ).length
      const successesWith = successObs.filter(
        (obs) => obs.precedingTools.includes(prereq)
      ).length

      if (failuresWithout >= this._minEvidence && successesWith >= 1) {
        this._promoteConstraint({
          type: 'requires',
          tool: successTool,
          condition: prereq,
        }, { failures: failuresWithout, successes: successesWith, overrides: 0 })
      }
    }
  }

  private _detectCascadeCandidate(failedTool: string): void {
    const recentFailures = this._observations
      .filter((obs) => !obs.success && obs.tool !== failedTool)
      .map((obs) => obs.tool)

    const precedingFailure = [...new Set(recentFailures)].find((trigger) => {
      const triggerObs = this._observations.filter(
        (obs) => obs.tool === trigger && !obs.success
      )
      const postTriggerFailures = this._observations.filter(
        (obs) => obs.tool === failedTool && !obs.success &&
        obs.precedingTools.some(() => {
          const triggerIdx = this._toolSequence.lastIndexOf(trigger)
          return triggerIdx >= 0
        })
      )
      return triggerObs.length >= 1 && postTriggerFailures.length >= this._minEvidence
    })

    if (!precedingFailure) return

    const key = `cascade:${precedingFailure}:${failedTool}`
    if (this._records.some((record) => constraintKey(record.constraint) === key)) return

    const existing = this._records.find(
      (record) => record.constraint.type === 'cascade' && record.constraint.trigger === precedingFailure
    )
    if (existing && existing.constraint.type === 'cascade') {
      if (!existing.constraint.blocks.includes(failedTool)) {
        existing.constraint.blocks.push(failedTool)
      }
    }
  }

  private _detectBudgetCandidate(toolName: string): void {
    const toolObs = this._observations.filter((obs) => obs.tool === toolName)
    const failures = toolObs.filter((obs) => !obs.success)
    const successes = toolObs.filter((obs) => obs.success)

    if (failures.length < this._minEvidence || successes.length === 0) return

    const successCounts = successes.map((_, index) => index + 1)
    const maxSuccessCount = Math.max(...successCounts, 0)

    if (maxSuccessCount === 0) return

    const failuresAfterMax = failures.filter((failObs) => {
      const failIdx = toolObs.indexOf(failObs)
      const callNumber = failIdx + 1
      return callNumber > maxSuccessCount
    })

    if (failuresAfterMax.length < this._minEvidence) return

    const budgetConstraint: BudgetConstraint = {
      type: 'budget',
      tool: toolName,
      maxCalls: maxSuccessCount,
    }

    if (!this._hasConstraint(budgetConstraint)) {
      this._promoteConstraint(budgetConstraint, {
        failures: failuresAfterMax.length,
        successes: successes.length,
        overrides: 0,
      })
    }
  }

  private _detectLoopCandidate(toolName: string): void {
    const toolObs = this._observations.filter((obs) => obs.tool === toolName)

    const inputCounts = new Map<string, { total: number; failures: number }>()
    for (const obs of toolObs) {
      const entry = inputCounts.get(obs.inputHash) ?? { total: 0, failures: 0 }
      entry.total++
      if (!obs.success) entry.failures++
      inputCounts.set(obs.inputHash, entry)
    }

    for (const [, counts] of inputCounts) {
      if (counts.failures >= this._minEvidence && counts.total > counts.failures) {
        const maxRepeats = counts.total - counts.failures
        const loopConstraint: LoopConstraint = {
          type: 'loop',
          tool: toolName,
          maxRepeats,
        }
        if (!this._hasConstraint(loopConstraint)) {
          this._promoteConstraint(loopConstraint, {
            failures: counts.failures,
            successes: counts.total - counts.failures,
            overrides: 0,
          })
        }
      }
    }
  }

  private _promoteConstraint(constraint: Constraint, evidence: ConstraintEvidence): void {
    if (this._hasConstraint(constraint)) return

    const hasConfirmation = evidence.successes >= 1
    this._records.push({
      constraint,
      evidence,
      status: hasConfirmation ? 'enforcing' : 'candidate',
      source: 'discovered',
    })
  }

  private _evaluate(constraint: Constraint, toolName: string, inputHash: string): string | undefined {
    switch (constraint.type) {
      case 'forbid':
        if (constraint.tool === toolName) {
          return `forbidden: ${toolName} is not permitted`
        }
        return undefined

      case 'requires':
        if (constraint.tool === toolName && !this._trajectory.completed.has(constraint.condition)) {
          return `requires: ${toolName} requires ${constraint.condition} to have completed first`
        }
        return undefined

      case 'loop': {
        const toolInputs = this._trajectory.inputHashes.get(toolName)
        if (constraint.tool === toolName && toolInputs) {
          const repeats = toolInputs.get(inputHash) ?? 0
          if (repeats >= constraint.maxRepeats) {
            return `loop: ${toolName} called ${repeats} times with same input (max ${constraint.maxRepeats})`
          }
        }
        return undefined
      }

      case 'cascade':
        if (constraint.blocks.includes(toolName) && this._trajectory.failed.has(constraint.trigger)) {
          return `cascade: ${toolName} blocked because ${constraint.trigger} failed`
        }
        return undefined

      case 'budget': {
        if (constraint.tool === toolName) {
          const count = this._trajectory.callCounts.get(toolName) ?? 0
          if (count >= constraint.maxCalls) {
            return `budget: ${toolName} exceeded max calls (${constraint.maxCalls})`
          }
        }
        return undefined
      }
    }
  }
}

function createTrajectory(): Trajectory {
  return {
    completed: new Set(),
    callCounts: new Map(),
    failed: new Set(),
    inputHashes: new Map(),
  }
}

function hashInput(input: unknown): string {
  return JSON.stringify(input ?? {})
}

function constraintKey(constraint: Constraint): string {
  switch (constraint.type) {
    case 'forbid':
      return `forbid:${constraint.tool}`
    case 'requires':
      return `requires:${constraint.tool}:${constraint.condition}`
    case 'loop':
      return `loop:${constraint.tool}:${constraint.maxRepeats}`
    case 'cascade':
      return `cascade:${constraint.trigger}:${constraint.blocks.join(',')}`
    case 'budget':
      return `budget:${constraint.tool}:${constraint.maxCalls}`
  }
}
