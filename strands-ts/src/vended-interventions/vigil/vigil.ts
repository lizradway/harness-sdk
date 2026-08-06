import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny } from '../../interventions/actions.js'
import type { InterventionAction } from '../../interventions/actions.js'
import type { BeforeToolCallEvent, AfterToolCallEvent } from '../../hooks/events.js'
import type { OnError } from '../../interventions/handler.js'
import type { Awaitable } from '../../interventions/handler.js'
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
 * Configuration for the {@link Vigil} intervention handler.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood | Dogwood Policy Language}
 */
export interface VigilConfig {
  /** Temporal constraints to enforce, in compiled typed JSON form. */
  constraints: Constraint[]

  /**
   * Error handling: `'throw'` (default), `'deny'` (fail-closed), `'proceed'` (fail-open).
   */
  onError?: OnError
}

/**
 * Execution trajectory tracked during a single agent invocation.
 * Records completed tools, call counts, failed tools, and per-tool input hashes
 * for loop detection.
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
 * Vigil: Dogwood temporal policy intervention handler.
 *
 * Evaluates compiled Dogwood temporal constraints against the agent's execution
 * trajectory on every `beforeToolCall`. Records tool outcomes on `afterToolCall`
 * to advance the trajectory state.
 *
 * Constraints evaluate as set membership checks and counter comparisons (microseconds).
 * No LLM in the enforcement path.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood | Dogwood Policy Language}
 *
 * @example
 * ```typescript
 * const vigil = new Vigil({
 *   constraints: [
 *     { type: 'requires', tool: 'charge', condition: 'authenticate' },
 *     { type: 'budget', tool: 'charge', maxCalls: 5 },
 *     { type: 'cascade', trigger: 'deploy', blocks: ['promote'] },
 *   ],
 * })
 *
 * const agent = new Agent({
 *   tools: [authenticate, charge, deploy, promote],
 *   interventions: [vigil],
 * })
 * ```
 */
export class Vigil extends InterventionHandler {
  readonly name = 'vigil'
  override readonly onError: OnError

  private readonly _constraints: Constraint[]
  private _trajectory: Trajectory

  constructor(config: VigilConfig) {
    super()
    this._constraints = config.constraints
    this.onError = config.onError ?? 'throw'
    this._trajectory = createTrajectory()
  }

  override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
    const toolName = event.toolUse.name
    const inputHash = hashInput(event.toolUse.input)

    for (const constraint of this._constraints) {
      const violation = this._evaluate(constraint, toolName, inputHash)
      if (violation) {
        return deny(violation)
      }
    }

    return proceed()
  }

  override afterToolCall(event: AfterToolCallEvent): Awaitable<Proceed | Transform> {
    const toolName = event.toolUse.name
    const inputHash = hashInput(event.toolUse.input)

    if (event.error || event.result.status === 'error') {
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

    return proceed()
  }

  /** Returns the currently enforced constraints. */
  getConstraints(): ReadonlyArray<Constraint> {
    return this._constraints
  }

  /** Resets the trajectory state. Call between invocations if reusing the handler. */
  resetTrajectory(): void {
    this._trajectory = createTrajectory()
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
