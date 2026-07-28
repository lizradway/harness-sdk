import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny } from '../../interventions/actions.js'
import type { Proceed, Deny, Guide, Transform, Confirm } from '../../interventions/actions.js'
import { AfterToolCallEvent } from '../../hooks/events.js'
import type { BeforeToolCallEvent } from '../../hooks/events.js'
import type { OnError, Awaitable } from '../../interventions/handler.js'
import type { LifecycleObserver } from '../../types/lifecycle-observer.js'
import type { LocalAgent } from '../../types/agent.js'
import type { Model } from '../../models/model.js'
import type { ToolSpec } from '../../tools/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single predicate representing a fact about the world state.
 * Predicates are strings like `file_exists("/tmp/x")` or `db_connected`.
 */
type Predicate = string

/**
 * Contract for a single tool: what must be true before calling it,
 * and what becomes true after it succeeds.
 */
export interface ToolContract {
  /** Predicates that must hold before the tool is called. */
  requires: Predicate[]
  /** Predicates that become true after the tool succeeds. */
  ensures: Predicate[]
  /** Predicates that become false after the tool succeeds. */
  revokes: Predicate[]
}

/**
 * Configuration for the {@link ContractEnforcer}.
 */
export interface ContractEnforcerConfig {
  /**
   * Model used to infer contracts from tool descriptions.
   * If omitted, uses the parent agent's model.
   */
  model?: Model

  /**
   * Hand-written contract overrides for specific tools.
   * These take precedence over LLM-inferred contracts.
   */
  overrides?: Record<string, Partial<ToolContract>>

  /**
   * Whether to deny tool calls when preconditions can't be verified
   * because state is unknown. When false (default), unknown predicates
   * are treated as satisfied (open-world assumption).
   *
   * @defaultValue `false`
   */
  closedWorld?: boolean

  /**
   * Error handling strategy.
   * @defaultValue `'throw'`
   */
  onError?: OnError
}

// ---------------------------------------------------------------------------
// Contract extraction prompt + schema
// ---------------------------------------------------------------------------

const CONTRACT_SCHEMA = z.object({
  contracts: z.array(
    z.object({
      tool: z.string().describe('The tool name'),
      requires: z
        .array(z.string())
        .describe('Predicates that must be true before calling this tool, e.g. file_exists(path)'),
      ensures: z
        .array(z.string())
        .describe('Predicates that become true after the tool succeeds, e.g. file_exists(path)'),
      revokes: z
        .array(z.string())
        .describe('Predicates that become false after the tool succeeds, e.g. file_exists(path)'),
    })
  ),
})

type ContractExtraction = z.infer<typeof CONTRACT_SCHEMA>

function buildExtractionPrompt(toolSpecs: ToolSpec[]): string {
  const toolDescriptions = toolSpecs
    .map(
      (spec) =>
        `- **${spec.name}**: ${spec.description}${spec.inputSchema ? `\n  Input: ${JSON.stringify(spec.inputSchema)}` : ''}`
    )
    .join('\n')

  return `Extract pre/postconditions (contracts) for each tool below.

For each tool, determine:
- **requires**: what must be true before calling it (e.g. "file_exists(path)", "user_authenticated", "db_connected")
- **ensures**: what becomes true after it succeeds (e.g. "file_exists(path)", "record_created(id)")
- **revokes**: what becomes false after it succeeds (e.g. "file_exists(path)" for a delete tool)

Use parameterized predicates where the parameter refers to a tool input field.
Use consistent predicate names across tools (e.g. if one tool ensures "file_exists(path)", another should require "file_exists(path)" not "file_available(path)").
Keep predicates simple and composable.
If a tool has no meaningful preconditions, use an empty array.

Tools:
${toolDescriptions}`
}

// ---------------------------------------------------------------------------
// State tracker
// ---------------------------------------------------------------------------

/**
 * Tracks known world-state predicates based on observed tool results.
 * @internal
 */
export class StateTracker {
  private readonly _facts = new Set<Predicate>()

  /** Add predicates that became true. */
  assert(predicates: Predicate[]): void {
    for (const predicate of predicates) {
      this._facts.add(predicate)
    }
  }

  /** Remove predicates that became false. */
  revoke(predicates: Predicate[]): void {
    for (const predicate of predicates) {
      this._facts.delete(predicate)
    }
  }

  /** Check if a predicate is known to be true. Returns undefined if unknown. */
  check(predicate: Predicate): boolean | undefined {
    if (this._facts.has(predicate)) return true
    return undefined
  }

  /** Check all predicates, returning any that are known to be false or unknown. */
  checkAll(predicates: Predicate[], closedWorld: boolean): Predicate[] {
    const violations: Predicate[] = []
    for (const predicate of predicates) {
      const known = this.check(predicate)
      if (known === undefined && closedWorld) {
        violations.push(predicate)
      }
    }
    return violations
  }

  /** Reset all state. */
  clear(): void {
    this._facts.clear()
  }
}

// ---------------------------------------------------------------------------
// Predicate grounding
// ---------------------------------------------------------------------------

/**
 * Given a parameterized predicate like "file_exists(path)" and the tool input
 * `{ path: "/tmp/x" }`, returns the grounded predicate "file_exists(/tmp/x)".
 * @internal
 */
export function groundPredicate(predicate: Predicate, toolInput: Record<string, unknown>): Predicate {
  const parenMatch = predicate.match(/^([^(]+)\((.+)\)$/)
  if (!parenMatch) return predicate

  const [, name, params] = parenMatch
  const grounded = params!.split(/,\s*/).map((param) => {
    const value = toolInput[param.trim()]
    return value !== undefined ? String(value) : param.trim()
  })
  return `${name}(${grounded.join(', ')})`
}

/**
 * Ground all predicates in a list against a tool's input.
 * @internal
 */
export function groundPredicates(predicates: Predicate[], toolInput: Record<string, unknown>): Predicate[] {
  return predicates.map((predicate) => groundPredicate(predicate, toolInput))
}

// ---------------------------------------------------------------------------
// ContractEnforcer
// ---------------------------------------------------------------------------

/**
 * Intervention handler that enforces tool contracts (pre/postconditions).
 *
 * At agent initialization, uses an LLM to infer contracts from tool descriptions.
 * At runtime, maintains a world-state model by observing tool results and checks
 * preconditions before each tool call — no LLM in the hot path.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { ContractEnforcer } from '@strands-agents/sdk/vended-interventions/contracts'
 *
 * const agent = new Agent({
 *   tools: [readFile, writeFile, deleteFile],
 *   interventions: [
 *     new ContractEnforcer({
 *       overrides: {
 *         delete_file: {
 *           requires: ['file_exists(path)', 'has_backup(path)'],
 *           ensures: [],
 *           revokes: ['file_exists(path)'],
 *         },
 *       },
 *     }),
 *   ],
 * })
 * ```
 */
export class ContractEnforcer extends InterventionHandler implements LifecycleObserver {
  override readonly name = 'strands:contract-enforcer'
  override readonly onError: OnError

  private readonly _configuredModel: Model | undefined
  private readonly _overrides: Record<string, Partial<ToolContract>>
  private readonly _closedWorld: boolean
  private _agentModel: Model | undefined
  private _contracts: Map<string, ToolContract> = new Map()
  private _state: StateTracker = new StateTracker()
  private _initialized = false
  private _initPromise: Promise<void> | undefined

  constructor(config?: ContractEnforcerConfig) {
    super()
    this.onError = config?.onError ?? 'throw'
    this._configuredModel = config?.model
    this._overrides = config?.overrides ?? {}
    this._closedWorld = config?.closedWorld ?? false
  }

  /**
   * Called by the agent during initialization. Registers the afterToolCall hook
   * for state tracking and triggers contract extraction.
   */
  async observeAgent(agent: LocalAgent): Promise<void> {
    this._agentModel = agent.model
    agent.addHook(AfterToolCallEvent, (event) => this._trackState(event))
    await this._extractContracts(agent)
  }

  override beforeToolCall(event: BeforeToolCallEvent): Awaitable<Proceed | Deny | Guide | Confirm | Transform> {
    if (!this._initialized) return { type: 'proceed' }

    const contract = this._contracts.get(event.toolUse.name)
    if (!contract || contract.requires.length === 0) return { type: 'proceed' }

    const input = (event.toolUse.input ?? {}) as Record<string, unknown>
    const grounded = groundPredicates(contract.requires, input)
    const violations = this._state.checkAll(grounded, this._closedWorld)

    if (violations.length > 0) {
      return deny(`Precondition not met: ${violations.join(', ')}`)
    }

    return proceed()
  }

  override afterToolCall(_event: AfterToolCallEvent): Awaitable<Proceed | Transform> {
    return { type: 'proceed' }
  }

  /** Get the current inferred contracts (for debugging/inspection). */
  getContracts(): ReadonlyMap<string, ToolContract> {
    return this._contracts
  }

  /** Get the current known state (for debugging/inspection). */
  getState(): StateTracker {
    return this._state
  }

  private _trackState(event: AfterToolCallEvent): void {
    if (event.error) return

    const contract = this._contracts.get(event.toolUse.name)
    if (!contract) return

    const input = (event.toolUse.input ?? {}) as Record<string, unknown>

    if (contract.ensures.length > 0) {
      this._state.assert(groundPredicates(contract.ensures, input))
    }
    if (contract.revokes.length > 0) {
      this._state.revoke(groundPredicates(contract.revokes, input))
    }
  }

  private async _extractContracts(agent: LocalAgent): Promise<void> {
    if (this._initPromise) {
      await this._initPromise
      return
    }

    this._initPromise = this._doExtract(agent)
    await this._initPromise
  }

  private async _doExtract(agent: LocalAgent): Promise<void> {
    const tools = agent.toolRegistry.list()
    const toolSpecs = tools.map((tool) => tool.toolSpec)

    // Apply overrides first
    for (const [toolName, override] of Object.entries(this._overrides)) {
      this._contracts.set(toolName, {
        requires: override.requires ?? [],
        ensures: override.ensures ?? [],
        revokes: override.revokes ?? [],
      })
    }

    // Find tools that need LLM inference (not already overridden)
    const needsInference = toolSpecs.filter((spec) => !this._overrides[spec.name])
    if (needsInference.length === 0) {
      this._initialized = true
      return
    }

    const model = this._configuredModel ?? this._agentModel
    if (!model) {
      this._initialized = true
      return
    }

    const inner = new Agent({
      model,
      structuredOutputSchema: CONTRACT_SCHEMA,
      printer: false,
    })

    const result = await inner.invoke(buildExtractionPrompt(needsInference))
    const extraction = CONTRACT_SCHEMA.parse(result.structuredOutput) as ContractExtraction

    for (const contract of extraction.contracts) {
      if (!this._contracts.has(contract.tool)) {
        this._contracts.set(contract.tool, {
          requires: contract.requires,
          ensures: contract.ensures,
          revokes: contract.revokes,
        })
      }
    }

    this._initialized = true
  }
}
