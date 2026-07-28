import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny, guide } from '../../interventions/actions.js'
import type { LifecycleEvent, Proceed, Deny, Guide, Transform, Confirm } from '../../interventions/actions.js'
import type { BeforeInvocationEvent, BeforeToolCallEvent, AfterToolCallEvent, BeforeModelCallEvent, AfterModelCallEvent } from '../../hooks/events.js'
import type { OnError, Awaitable } from '../../interventions/handler.js'

type BeforeInvocationAction = Proceed | Deny | Guide | Transform
type BeforeToolCallAction = Proceed | Deny | Guide | Confirm | Transform
type AfterToolCallAction = Proceed | Transform
type BeforeModelCallAction = Proceed | Deny | Guide | Transform
type AfterModelCallAction = Proceed | Guide | Transform

/**
 * Result returned by a Lean checker module.
 *
 * The checker evaluates an encoded lifecycle event and returns a verdict
 * indicating whether the operation should proceed, be rejected, or receive guidance.
 */
export interface CheckerResult {
  /** The checker's decision. */
  verdict: 'accept' | 'reject' | 'guide'
  /** Human-readable explanation of the decision. Used as the deny reason or guide feedback. */
  reason?: string
  /** Opaque patch data for custom decode functions that produce Transform actions. */
  patch?: unknown
}

/**
 * Interface for a compiled Lean 4 checker module (typically WASM).
 *
 * The module exposes a single synchronous `check` method that accepts a JSON-encoded
 * input and returns a JSON-encoded {@link CheckerResult}. WASM execution is synchronous;
 * the async boundary exists only at the loading/compilation stage.
 *
 * @example
 * ```typescript
 * const checker: CheckerModule = {
 *   check(input: string): string {
 *     const data = JSON.parse(input)
 *     const valid = leanVerify(data)
 *     return JSON.stringify({ verdict: valid ? 'accept' : 'reject', reason: 'invariant violated' })
 *   }
 * }
 * ```
 */
export interface CheckerModule {
  /**
   * Run the checker on encoded input.
   *
   * @param input - JSON string representing the encoded lifecycle event.
   * @returns JSON string representing a {@link CheckerResult}.
   */
  check(input: string): string
}

/**
 * Codec that maps SDK lifecycle events to checker input and checker results to intervention actions.
 *
 * The codec is the user-provided "glue" that makes a generic Lean checker specific to a
 * particular invariant and lifecycle event type.
 */
export interface Codec {
  /**
   * Serialize the lifecycle event into the structure the checker expects.
   *
   * @param event - The lifecycle event being evaluated.
   * @returns A JSON-serializable value to pass to the checker, or `undefined` to skip checking
   *   (equivalent to returning Proceed).
   */
  encode(event: LifecycleEvent): unknown | undefined

  /**
   * Map the checker's result to an SDK intervention action.
   *
   * When omitted, the default mapping applies:
   * - `accept` → `proceed()`
   * - `reject` → `deny(reason)`
   * - `guide` → `guide(reason)`
   *
   * @param result - The parsed checker result.
   * @param event - The original lifecycle event (for constructing Transform actions).
   * @returns The intervention action to apply.
   */
  decode?(result: CheckerResult, event: LifecycleEvent): Proceed | Deny | Guide | Transform
}

/**
 * Which lifecycle methods the handler should activate.
 * Inactive methods return Proceed immediately without invoking the checker.
 */
export interface ActiveMethods {
  /** Activate beforeInvocation checking. */
  beforeInvocation?: boolean
  /** Activate beforeToolCall checking. Default: true. */
  beforeToolCall?: boolean
  /** Activate afterToolCall checking. */
  afterToolCall?: boolean
  /** Activate beforeModelCall checking. */
  beforeModelCall?: boolean
  /** Activate afterModelCall checking. */
  afterModelCall?: boolean
}

/**
 * Configuration for the {@link LeanVerifiedHandler}.
 */
export interface LeanVerifiedHandlerConfig {
  /** Unique handler name. Required to prevent accidental duplicates in the intervention pipeline. */
  name: string

  /**
   * The Lean checker module. Accepts either:
   * - A pre-loaded {@link CheckerModule} instance
   * - A factory function that lazily produces one (called once on first use, result cached)
   */
  checker: CheckerModule | (() => CheckerModule | Promise<CheckerModule>)

  /** Encode/decode layer mapping lifecycle events to checker I/O. */
  codec: Codec

  /**
   * Which lifecycle methods to activate.
   * @defaultValue `{ beforeToolCall: true }`
   */
  activeMethods?: ActiveMethods

  /**
   * Error handling strategy when the checker or codec throws.
   * @defaultValue `'throw'`
   */
  onError?: OnError
}

const DEFAULT_ACTIVE_METHODS: Required<ActiveMethods> = {
  beforeInvocation: false,
  beforeToolCall: true,
  afterToolCall: false,
  beforeModelCall: false,
  afterModelCall: false,
}

const DEFAULT_REASON = 'checker rejected the operation'

function defaultDecode(result: CheckerResult): Proceed | Deny | Guide {
  switch (result.verdict) {
    case 'accept':
      return proceed(result.reason ? { reason: result.reason } : undefined)
    case 'reject':
      return deny(result.reason ?? DEFAULT_REASON)
    case 'guide':
      return guide(result.reason ?? DEFAULT_REASON, undefined)
    default:
      return deny(`unknown checker verdict: ${result.verdict as string}`)
  }
}

/**
 * Intervention handler that delegates decisions to a compiled Lean 4 checker.
 *
 * The checker verifies semantic invariants (data preservation, idempotency, DAG ordering)
 * that go beyond type/schema-level checks. Its correctness is guaranteed by Lean's kernel —
 * bugs can only exist in the encoding layer (the {@link Codec}), not the decision logic.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { LeanVerifiedHandler } from '@strands-agents/sdk/vended-interventions/lean'
 *
 * const handler = new LeanVerifiedHandler({
 *   name: 'plan-validator',
 *   checker: myCompiledLeanModule,
 *   codec: {
 *     encode: (event) => ({ toolName: event.toolUse.name, input: event.toolUse.input }),
 *     decode: (result) => result.verdict === 'accept' ? proceed() : deny(result.reason),
 *   },
 * })
 *
 * const agent = new Agent({ interventions: [handler], tools: [...] })
 * ```
 */
export class LeanVerifiedHandler extends InterventionHandler {
  override readonly name: string
  override readonly onError: OnError

  private _checker: CheckerModule | undefined
  private _checkerInit: Promise<CheckerModule> | undefined
  private readonly _checkerSource: CheckerModule | (() => CheckerModule | Promise<CheckerModule>)
  private readonly _codec: Codec
  private readonly _activeMethods: Required<ActiveMethods>

  constructor(config: LeanVerifiedHandlerConfig) {
    super()
    this.name = config.name
    this.onError = config.onError ?? 'throw'
    this._codec = config.codec
    this._activeMethods = { ...DEFAULT_ACTIVE_METHODS, ...config.activeMethods }

    if (typeof config.checker === 'function') {
      this._checkerSource = config.checker
    } else {
      this._checker = config.checker
      this._checkerSource = config.checker
    }
  }

  /**
   * Eagerly initialize the checker module. Call before first use to avoid cold-start latency.
   * Safe to call multiple times — initialization only runs once.
   */
  async ready(): Promise<void> {
    await this._getChecker()
  }

  override beforeInvocation(event: BeforeInvocationEvent): Awaitable<BeforeInvocationAction> {
    if (!this._activeMethods.beforeInvocation) return { type: 'proceed' }
    return this._evaluate(event) as Promise<BeforeInvocationAction>
  }

  override beforeToolCall(event: BeforeToolCallEvent): Awaitable<BeforeToolCallAction> {
    if (!this._activeMethods.beforeToolCall) return { type: 'proceed' }
    return this._evaluate(event) as Promise<BeforeToolCallAction>
  }

  override afterToolCall(event: AfterToolCallEvent): Awaitable<AfterToolCallAction> {
    if (!this._activeMethods.afterToolCall) return { type: 'proceed' }
    return this._evaluate(event) as Promise<AfterToolCallAction>
  }

  override beforeModelCall(event: BeforeModelCallEvent): Awaitable<BeforeModelCallAction> {
    if (!this._activeMethods.beforeModelCall) return { type: 'proceed' }
    return this._evaluate(event) as Promise<BeforeModelCallAction>
  }

  override afterModelCall(event: AfterModelCallEvent): Awaitable<AfterModelCallAction> {
    if (!this._activeMethods.afterModelCall) return { type: 'proceed' }
    return this._evaluate(event) as Promise<AfterModelCallAction>
  }

  private async _evaluate(event: LifecycleEvent): Promise<Proceed | Deny | Guide | Transform> {
    const encoded = this._codec.encode(event)
    if (encoded === undefined) return proceed()

    const checker = await this._getChecker()
    const input = JSON.stringify(encoded)
    const output = checker.check(input)
    const result: CheckerResult = JSON.parse(output) as CheckerResult

    if (this._codec.decode) {
      return this._codec.decode(result, event)
    }
    return defaultDecode(result)
  }

  private async _getChecker(): Promise<CheckerModule> {
    if (this._checker) return this._checker

    if (!this._checkerInit) {
      this._checkerInit = Promise.resolve(
        (this._checkerSource as () => CheckerModule | Promise<CheckerModule>)()
      ).then((module) => {
        this._checker = module
        return module
      })
    }

    return this._checkerInit
  }
}
