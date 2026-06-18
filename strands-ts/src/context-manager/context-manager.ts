/**
 * The {@link ContextManager}: a single plugin that unifies compression,
 * offloading, eviction, and protection under one model.
 *
 * Everything it does under budget pressure is a {@link CompressionMethod} applied
 * to messages. The ContextManager owns the surrounding concerns the design
 * assigns to it: priority-based candidate selection, pin filtering, L1 transcript
 * writing, budget tracking, and overflow recovery. Methods only decide how to
 * transform the candidates they are handed.
 */

import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent } from '../types/agent.js'
import type { Model } from '../models/model.js'
import { Message } from '../types/messages.js'
import { InitializedEvent, BeforeModelCallEvent, AfterModelCallEvent, AfterToolCallEvent } from '../hooks/events.js'
import { ContextWindowOverflowError } from '../errors.js'
import { applyPinFirst } from '../conversation-manager/compression/pin-message.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT } from '../conversation-manager/conversation-manager.js'
import { InMemoryStorage } from '../vended-plugins/context-offloader/storage.js'
import type { Tool } from '../tools/tool.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import type { CompressionMethod, ContextManagerConfig, MethodLike, Scratchpad, TokenBudget } from './types.js'
import { resolveMethod, OffloadMethod, SummarizeMethod, DEFAULT_RECOVERY_HINT } from './methods.js'
import { ContentRouter } from './content-router.js'
import { Transcript, type TranscriptReader } from './transcript.js'
import { scoreMessages } from './priority.js'
import { messageText } from './content.js'

/** Default proactive-compression threshold (fraction of the context window). */
const DEFAULT_THRESHOLD = 0.85
/** Default number of leading messages to pin. */
const DEFAULT_PROTECT_FIRST = 1
/**
 * Tool names whose results must never be re-compressed: they return content the
 * agent just recovered, so offloading them again would create a retrieve→offload
 * loop. Covers this manager's own L1 tools plus the standalone ContextOffloader's
 * `retrieve_offloaded_content`, in case both are composed on one agent.
 */
const RETRIEVAL_TOOL_NAMES = new Set(['get_history', 'search_history', 'retrieve_offloaded_content'])

/** Build the method tree the `"auto"` preset resolves to. */
function autoMethod(): ContentRouter {
  return new ContentRouter({
    toolResults: new OffloadMethod({ preview: 'head-tail', thresholdRatio: 0.0075, keepRecent: 3 }),
    toolResultErrors: 'drop',
    assistantMessages: new SummarizeMethod({ ratio: 0.3 }),
    userMessages: 'protect',
    images: 'offload',
  })
}

/**
 * Unified context manager plugin.
 *
 * Set it on an agent via the `contextManager` option. When set, the agent's
 * {@link ConversationManager} is disabled and the ContextManager owns all
 * compression, overflow recovery, and proactive reduction.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { ContextManager, ContentRouter, OffloadMethod } from '@strands-agents/sdk/context-manager'
 *
 * const agent = new Agent({
 *   contextManager: new ContextManager({
 *     method: new ContentRouter({
 *       toolResults: new OffloadMethod({ preview: 'head-tail', keepRecent: 3 }),
 *       userMessages: 'protect',
 *     }),
 *   }),
 * })
 * ```
 */
export class ContextManager implements Plugin {
  readonly name = 'strands:context-manager'

  private readonly _method: CompressionMethod
  private readonly _scratchpad: Scratchpad
  private readonly _threshold: number
  private readonly _protectFirst: number
  private readonly _transcriptEnabled: boolean
  private readonly _retrievalEnabled: boolean
  private readonly _transcript: Transcript | undefined
  private readonly _telemetry: boolean
  private _pinFirstApplied = false
  private _lastBudget: TokenBudget | undefined
  private _agent: LocalAgent | undefined

  /**
   * @param config - Context manager configuration. Omit for the `"auto"` preset.
   */
  constructor(config?: ContextManagerConfig) {
    const preset = config?.preset
    if (preset !== undefined && preset !== 'auto') {
      throw new Error(`Unsupported ContextManager preset: "${preset}". Supported presets: "auto"`)
    }

    const threshold = config?.threshold ?? DEFAULT_THRESHOLD
    if (threshold <= 0 || threshold > 1) {
      throw new Error(`threshold must be between 0 (exclusive) and 1 (inclusive), got ${threshold}`)
    }

    this._scratchpad = config?.scratchpad ?? new InMemoryStorage()
    this._threshold = threshold
    this._protectFirst = config?.protectFirst ?? DEFAULT_PROTECT_FIRST
    this._telemetry = config?.telemetry ?? false

    // Resolve the method. Both the explicit method and the "auto" preset default
    // to the auto router when nothing is supplied.
    const methodSpec: MethodLike = config?.method ?? autoMethod()
    this._method = resolveMethod(methodSpec)
    this._injectScratchpad(this._method)

    const transcriptConfig = config?.transcript ?? {}
    this._transcriptEnabled = transcriptConfig.enabled ?? true
    this._retrievalEnabled = transcriptConfig.retrieval ?? true
    this._transcript = this._transcriptEnabled
      ? new Transcript({
          scratchpad: this._scratchpad,
          ...(transcriptConfig.maxSize !== undefined && { maxSize: transcriptConfig.maxSize }),
          ...(transcriptConfig.eviction !== undefined && { eviction: transcriptConfig.eviction }),
        })
      : undefined

    // Tell lossy methods to point the model at the retrieval tools — but only
    // when those tools are actually registered, so we never promise a tool the
    // model can't call.
    if (this._transcriptEnabled && this._retrievalEnabled) {
      this._supplyRecoveryHint(this._method, DEFAULT_RECOVERY_HINT)
    }
  }

  // ----- Public instance API -------------------------------------------------

  /** The most recent token budget snapshot, or a zeroed budget before the first model call. */
  get budget(): TokenBudget {
    return this._lastBudget ?? { limit: 0, used: 0, remaining: 0, ratio: 0, target: 0 }
  }

  /** Read access to the L1 transcript. Throws if the transcript is disabled. */
  get transcript(): TranscriptReader {
    if (!this._transcript) throw new Error('Transcript is disabled on this ContextManager')
    return this._transcript
  }

  /** Trigger a compression pass immediately, freeing toward the threshold. */
  async compress(): Promise<void> {
    if (!this._agent) throw new Error('ContextManager.compress() called before the agent was initialized')
    await this._runCompression(this._agent, this._agent.model)
  }

  /** Pin a message by index so it is never selected as an eviction candidate. */
  pin(messageIndex: number): void {
    if (!this._agent) throw new Error('ContextManager.pin() called before the agent was initialized')
    const message = this._agent.messages[messageIndex]
    if (message) {
      message.metadata = { ...message.metadata, custom: { ...message.metadata?.custom, pinned: true } }
    }
  }

  /** Unpin a previously pinned message by index. */
  unpin(messageIndex: number): void {
    if (!this._agent) throw new Error('ContextManager.unpin() called before the agent was initialized')
    const message = this._agent.messages[messageIndex]
    if (message?.metadata?.custom?.pinned) {
      const { pinned: _pinned, ...restCustom } = message.metadata.custom
      message.metadata = { ...message.metadata, custom: restCustom }
    }
  }

  // ----- Plugin lifecycle ----------------------------------------------------

  initAgent(agent: LocalAgent): void {
    this._agent = agent
    if (this._scratchpad instanceof InMemoryStorage) {
      this._scratchpad._bind(agent)
    }
    // Summarize methods need a model; give them the agent's when none was set.
    this._supplyModel(this._method, agent.model)

    agent.addHook(InitializedEvent, () => {
      logger.debug(`context_manager=<${this.name}>, threshold=<${this._threshold}> | initialized`)
    })

    // Proactive compression: reduce before the model call when over threshold.
    agent.addHook(BeforeModelCallEvent, async (event) => {
      const budget = this._computeBudget(event.model, event.projectedInputTokens)
      this._lastBudget = budget
      if (this._scratchpad instanceof InMemoryStorage) {
        this._cycle++
        this._scratchpad._evict(this._cycle)
      }
      if (event.projectedInputTokens === undefined) return
      if (budget.ratio >= this._threshold) {
        try {
          await this._runCompression(event.agent, event.model)
        } catch (err) {
          logger.warn(`context_manager=<${this.name}> | proactive compression failed, continuing | error=<${err}>`)
        }
      }
    })

    // Reactive recovery: a real overflow must be resolved or it propagates.
    agent.addHook(AfterModelCallEvent, async (event) => {
      if (event.error instanceof ContextWindowOverflowError) {
        const reduced = await this._runCompression(event.agent, event.model, { reactive: true })
        if (reduced) event.retry = true
      }
    })

    // Eager tool-result offload: shrink oversized results as soon as they arrive.
    agent.addHook(AfterToolCallEvent, async (event) => {
      await this._maybeOffloadToolResult(event)
    })
  }

  getTools(): Tool[] {
    if (!this._transcript || !this._retrievalEnabled) return []
    return this._transcript.retrievalTools()
  }

  /** Expose the transcript so a MemoryManager can read L1 for L2 extraction. */
  get transcriptSource(): TranscriptReader | undefined {
    return this._transcript
  }

  // ----- Internals -----------------------------------------------------------

  private _cycle = 0

  /** Recursively hand the scratchpad to any offload methods that lack one. */
  private _injectScratchpad(method: CompressionMethod): void {
    if (method instanceof OffloadMethod) {
      method.setScratchpad(this._scratchpad)
    }
    if (method instanceof ContentRouter) {
      for (const spec of method.methodSpecs()) {
        if (typeof spec !== 'string') this._injectScratchpad(spec)
      }
    }
  }

  /** Recursively give every lossy method that supports it the L1 recovery hint. */
  private _supplyRecoveryHint(method: CompressionMethod, hint: string): void {
    const settable = method as Partial<{ setRecoveryHint(hint: string): void }>
    if (typeof settable.setRecoveryHint === 'function') {
      settable.setRecoveryHint(hint)
    }
    if (method instanceof ContentRouter) {
      for (const spec of method.methodSpecs()) {
        if (typeof spec !== 'string') this._supplyRecoveryHint(spec, hint)
      }
    }
  }

  /** Recursively give every method that supports it the current task/query text. */
  private _supplyQuery(method: CompressionMethod, query: string): void {
    const settable = method as Partial<{ setQuery(query: string): void }>
    if (typeof settable.setQuery === 'function') {
      settable.setQuery(query)
    }
    if (method instanceof ContentRouter) {
      for (const spec of method.methodSpecs()) {
        if (typeof spec !== 'string') this._supplyQuery(spec, query)
      }
    }
  }

  /**
   * Derive the task/query text used by the `importance` preview mode: the system
   * prompt plus the text of the most recent user messages. This is what the agent
   * is working on, so importance scoring keeps the lines relevant to it.
   */
  private _deriveQuery(agent: LocalAgent): string {
    const parts: string[] = []
    if (typeof agent.systemPrompt === 'string') parts.push(agent.systemPrompt)
    const recentUser = agent.messages.filter((m) => m.role === 'user').slice(-3)
    for (const m of recentUser) parts.push(messageText(m))
    return parts.join('\n').slice(0, 4000)
  }

  private _computeBudget(model: Model, projected: number | undefined): TokenBudget {
    let limit = model.getConfig().contextWindowLimit
    if (limit === undefined) {
      limit = DEFAULT_CONTEXT_WINDOW_LIMIT
      warnOnce(
        logger,
        `context_manager=<${this.name}> | contextWindowLimit is not set on the model, using default of ${DEFAULT_CONTEXT_WINDOW_LIMIT}`
      )
    }
    const used = projected ?? 0
    const remaining = Math.max(0, limit - used)
    const ratio = limit > 0 ? used / limit : 0
    const target = Math.max(0, used - Math.floor(this._threshold * limit))
    return { limit, used, remaining, ratio, target }
  }

  /**
   * Run a compression pass: pick the lowest-priority evictable messages as
   * candidates, preserve them to L1, transform them with the method, and merge
   * the result back into the conversation in place.
   *
   * @returns `true` if the conversation was modified.
   */
  private async _runCompression(agent: LocalAgent, model: Model, options?: { reactive?: boolean }): Promise<boolean> {
    if (this._protectFirst > 0 && !this._pinFirstApplied) {
      applyPinFirst(agent.messages, this._protectFirst)
      this._pinFirstApplied = true
    }

    const budget = this._lastBudget ?? this._computeBudget(model, await this._countUsed(agent, model))
    const candidates = this._selectCandidates(agent.messages, budget, options?.reactive ?? false)
    if (candidates.length === 0) {
      if (options?.reactive)
        logger.warn(`context_manager=<${this.name}> | no evictable candidates for overflow recovery`)
      return false
    }

    const indices = candidates.map((c) => c.index)
    const originals = candidates.map((c) => c.message)

    // Preserve originals to L1 before any lossy transformation. Methods decide
    // *how* to transform; the ContextManager decides *whether* to preserve. A
    // message is not preserved when it is protected (stays in L0) or when its
    // resolved method is `drop` / `protect` (no recoverable transformation).
    // Pass each message's conversation index so L1 reads back in order.
    if (this._transcript) {
      const preserved = candidates.filter((c) => this._shouldPreserve(c.message))
      await this._transcript.append(
        preserved.map((c) => c.message),
        preserved.map((c) => c.index)
      )
    }

    // Give importance-mode methods the current task/query before they run.
    this._supplyQuery(this._method, this._deriveQuery(agent))

    let transformed: Message[]
    try {
      transformed = await this._compressWithModel(originals, budget, model)
    } catch (err) {
      if (options?.reactive) throw err
      logger.warn(`context_manager=<${this.name}> | compression method threw, continuing | error=<${err}>`)
      return false
    }

    this._spliceContiguous(agent.messages, indices, transformed)
    logger.debug(
      `context_manager=<${this.name}>, candidates=<${originals.length}>, result=<${transformed.length}> | compression applied`
    )
    return true
  }

  /** Decide whether a candidate's original should be written to the L1 transcript. */
  private _shouldPreserve(message: Message): boolean {
    // Per the design: every lossy transformation persists the original to L1
    // first. The only exceptions are `protect` (stays in L0 unchanged) and
    // `drop` (explicitly discards without preservation). Offload still writes L1.
    if (isProtected(message)) return false
    const method = this._method instanceof ContentRouter ? this._method.resolvedMethodFor(message) : this._method
    return method.name !== 'drop' && method.name !== 'protect'
  }

  /** Invoke the method, threading the agent model into summarize-style methods that need one. */
  private async _compressWithModel(messages: Message[], budget: TokenBudget, model: Model): Promise<Message[]> {
    this._supplyModel(this._method, model)
    return this._method.compress(messages, budget)
  }

  /**
   * Recursively give every SummarizeMethod the agent model when it has none.
   * The router calls each method's `compress()`, which throws without a model,
   * so the manager supplies its own model before any compression runs.
   */
  private _supplyModel(method: CompressionMethod, model: Model): void {
    if (method instanceof SummarizeMethod) {
      method.setModel(model)
    }
    if (method instanceof ContentRouter) {
      for (const spec of method.methodSpecs()) {
        if (typeof spec !== 'string') this._supplyModel(spec, model)
      }
    }
  }

  /**
   * Select the lowest-priority, evictable messages as compression candidates.
   *
   * For proactive passes, stops once enough tokens would be freed to reach the
   * threshold. For reactive passes, takes a meaningful slice of the lowest
   * priority messages so overflow recovery makes real progress.
   */
  private _selectCandidates(
    messages: Message[],
    budget: TokenBudget,
    reactive: boolean
  ): Array<{ index: number; message: Message }> {
    const scored = scoreMessages(messages).filter((s) => Number.isFinite(s.priority))
    if (scored.length === 0) return []

    // Lowest priority first; break ties by oldest-first so recency is respected.
    scored.sort((a, b) => a.priority - b.priority || a.index - b.index)

    const targetTokens = reactive ? Math.max(budget.target, Math.ceil(budget.used * 0.3)) : budget.target
    const chosen: Array<{ index: number; message: Message }> = []
    let freed = 0
    for (const s of scored) {
      chosen.push({ index: s.index, message: s.message })
      freed += approxTokens(s.message)
      if (!reactive && targetTokens > 0 && freed >= targetTokens) break
    }
    // Return in original document order so contiguous-splice logic is stable.
    return chosen.sort((a, b) => a.index - b.index)
  }

  /**
   * Replace the selected indices with the transformed messages.
   *
   * The transformed block is inserted at the position of the first candidate and
   * all candidate indices are removed, which keeps the surrounding (kept)
   * messages in their original relative order.
   */
  private _spliceContiguous(messages: Message[], indices: number[], transformed: Message[]): void {
    const indexSet = new Set(indices)
    const insertAt = indices[0]!
    const rebuilt: Message[] = []
    let inserted = false
    for (let i = 0; i < messages.length; i++) {
      if (indexSet.has(i)) {
        if (!inserted) {
          rebuilt.push(...transformed)
          inserted = true
        }
        continue
      }
      rebuilt.push(messages[i]!)
    }
    if (!inserted) rebuilt.splice(insertAt, 0, ...transformed)
    messages.splice(0, messages.length, ...rebuilt)
  }

  private async _countUsed(agent: LocalAgent, model: Model): Promise<number> {
    return model.countTokens(agent.messages, agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : undefined)
  }

  /** Offload an oversized successful tool result immediately, mirroring the auto preset. */
  private async _maybeOffloadToolResult(event: AfterToolCallEvent): Promise<void> {
    if (event.result.status === 'error') return
    // Never re-compress content the agent just retrieved from L1, or it loops:
    // retrieve → offload → retrieve → offload.
    if (RETRIEVAL_TOOL_NAMES.has(event.toolUse.name)) return
    const offload = this._findOffloadMethod()
    if (!offload) return
    this._supplyQuery(offload, this._deriveQuery(event.agent))
    const message = new Message({ role: 'user', content: [event.result] })
    const budget = this._lastBudget ?? this._computeBudget(event.agent.model, undefined)
    const [out] = await offload.compress([message], budget)
    if (out && out !== message) {
      // Lossy transformation: persist the original to L1 first (design §2.2),
      // unless offload is configured to skip L1 (design §2.1 keeps offload at "yes").
      // A just-produced tool result is the latest message, so it sorts last in L1.
      if (this._transcript) await this._transcript.append([message], [event.agent.messages.length])
      const block = out.content.find((b) => b.type === 'toolResultBlock')
      if (block && block.type === 'toolResultBlock') event.result = block
    }
  }

  /** Find an OffloadMethod in the configured method tree, if any. */
  private _findOffloadMethod(): OffloadMethod | undefined {
    if (this._method instanceof OffloadMethod) return this._method
    if (this._method instanceof ContentRouter) {
      for (const spec of this._method.methodSpecs()) {
        if (spec instanceof OffloadMethod) return spec
      }
    }
    return undefined
  }
}

/** Approximate token count for a message, used for candidate budgeting. */
function approxTokens(message: Message): number {
  let chars = 0
  for (const block of message.content) {
    chars += JSON.stringify(block.toJSON()).length
  }
  return Math.ceil(chars / 4)
}

/** A protected (pinned) message is never written to L1 because it stays in L0. */
function isProtected(message: Message): boolean {
  return message.metadata?.custom?.pinned === true
}
