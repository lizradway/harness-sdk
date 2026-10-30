/**
 * Base offload strategy: conditions, target routing, eager hooks, and the shared per-block and
 * message-level execution paths.
 */

import { logger } from '../../../logging/logger.js'
import { MessageAddedEvent } from '../../../hooks/events.js'
import {
  isOffloaded,
  Message,
  TextBlock,
  type OffloadMethod,
  ToolResultBlock,
  ToolUseBlock,
  CachePointBlock,
  ReasoningBlock,
} from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import type { Stash } from '../../stash.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'
import { formatElided, offloadPlaceholder } from '../../placeholder.js'
import { insertMarker, repairAlternation, spliceWithPairs, withPairs } from '../../message-trimming.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import { ResolvedConditions, type OffloadConditions } from './conditions.js'
import { buildToolNameMap, isMediaBlock, OffloadTargetMatcher, type OffloadTarget } from './target.js'

/**
 * Strategy returned by `Offload.drop/truncate/summarize`. Without conditions it acts on each matching block as it
 * arrives, including the one the model answers next; target `'*'` needs conditions from `.when()`. A
 * strategy keeps per-agent state, so give each agent its own.
 *
 * @experimental
 */
export interface OffloadStrategy extends ContextStrategy {
  /** Returns a copy of this strategy with these conditions in place of its current ones. */
  when(conditions?: OffloadConditions): OffloadStrategy
}

/**
 * Writes the placeholder text for messages about to be removed, such as `[Dropped: 3 messages]` or a summary of them.
 * It gets the messages with their tool pairs added, so its count or summary covers everything that leaves. Returning
 * null keeps the messages, as summarize does when its model call fails.
 */
type PlaceholderText = (removed: Message[]) => Promise<string | null>

/**
 * What {@link removeMessages} needs from the strategy calling it. It is a function rather than a method so that
 * {@link EmergencyTruncateStrategy}, which is not a {@link BaseOffloadStrategy}, can share it.
 */
interface Remover {
  /** Strategy name, logged when the stash write fails. */
  name: string
  /** Method recorded in the placeholder's `metadata.offloaded`. */
  method: OffloadMethod
  /** Where the removed messages are stored for retrieval, or undefined when there is no stash. */
  stash: Stash | undefined
}

/**
 * Removes messages with their tool pairs, stashes them under one reference, and leaves a placeholder at the gap. A
 * failed stash write leaves the placeholder without a reference. Callers restore alternation once they are done.
 *
 * @returns Whether anything was removed
 */
async function removeMessages(
  messages: Message[],
  toRemove: Message[],
  textFor: PlaceholderText,
  { name, method, stash }: Remover
): Promise<boolean> {
  const removed = withPairs(messages, toRemove)
  if (removed.length === 0) return false
  const text = await textFor(removed)
  if (text === null) return false

  const { lowestIndex } = spliceWithPairs(messages, removed)
  let stashRef: string | undefined
  try {
    stashRef = await stash?.storeRemoved(removed)
  } catch (error) {
    logger.warn(`strategy=<${name}>, error=<${error}> | failed to stash removed messages`)
  }
  insertMarker(messages, lowestIndex, offloadPlaceholder(method, text, stashRef, removed.length))
  return true
}

/** Shared offload logic: conditions, firing, granularity, eager hooks, preserveRecent. */
export abstract class BaseOffloadStrategy implements OffloadStrategy {
  readonly name: string

  protected readonly _method: OffloadMethod
  protected readonly _target: OffloadTarget | undefined
  protected readonly _matcher: OffloadTargetMatcher
  protected readonly _conditions: ResolvedConditions
  /** Whether the eager hook processes each message as it arrives. */
  private readonly _runsEagerly: boolean
  protected _stash: Stash | undefined
  private _warnedUnconditional = false

  /**
   * @param method - Offload method; the strategy is named `offload:<method>`
   * @param target - Content the strategy acts on
   * @param conditions - When and how the strategy fires; omitted, it acts on each matching block as it arrives
   * @throws Error when the target is empty or excludes every tool it includes, a condition value is invalid, or
   *   conditions are given that leave the strategy unable to run (see {@link BaseOffloadStrategy.init})
   */
  constructor(method: OffloadMethod, target?: OffloadTarget, conditions?: OffloadConditions) {
    this.name = `offload:${method}`
    this._method = method
    this._target = target
    this._matcher = new OffloadTargetMatcher(target)
    this._conditions = new ResolvedConditions(conditions)
    this._runsEagerly = target !== '*' && !this._conditions.defersArrival
    if (conditions) this._checkRunnable()
  }

  /**
   * Returns a copy of this strategy with these conditions in place of its current ones.
   *
   * @param conditions - When and how the strategy fires
   * @returns The strategy with these conditions. A strategy keeps per-agent state, so give each agent its own.
   * @throws Error when a condition value is invalid, or the conditions leave the strategy unable to run
   */
  when(conditions: OffloadConditions = {}): BaseOffloadStrategy {
    return this._withConditions(conditions)
  }

  /** Builds the same strategy, with the same target and config, under new conditions. */
  protected abstract _withConditions(conditions: OffloadConditions): BaseOffloadStrategy

  /** Throws if the conditions leave the strategy acting on every message. */
  private _checkRunnable(): void {
    if (this._target === '*' && this._conditions.isEmpty) {
      throw new Error(
        `Offload.${this._method}("*") would act on every message; use .when() to set contextUtilization, blockThreshold, or a preserveRecent above 0`
      )
    }
  }

  private _warnUnconditional(): void {
    if (this._warnedUnconditional || !this._conditions.isEmpty) return
    this._warnedUnconditional = true
    logger.warn(
      `strategy=<${this.name}>, target=<${JSON.stringify(this._target)}> | strategy has no conditions, so it acts on every matching block as it arrives, before the model reads it | use .when() to set blockThreshold, contextUtilization, or preserveRecent`
    )
  }

  /**
   * Checks the conditions can run on this agent, then registers the eager hook if this runs eagerly.
   *
   * @param agent - The agent this strategy is attached to
   * @param stash - The stash offloaded content is stored in
   * @throws Error when a whole-message strategy has none of `contextUtilization`, `blockThreshold`, or
   *   `preserveRecent`, or `contextUtilization` is a token count larger than the model's `contextWindowLimit`
   */
  init(agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
    this._checkRunnable()
    this._conditions.checkFits(agent)
    if (!this._runsEagerly) return
    agent.addHook(MessageAddedEvent, async (event) => {
      const messages = event.agent.messages
      const index = messages.indexOf(event.message)
      if (index >= 0 && isPinned(messages, index)) return
      const threshold = this._conditions.thresholdTokens(event.agent)
      await this._transformBlocks(event.message, messages, buildToolNameMap(messages), threshold, event.agent)
    })
  }

  async apply(context: ContextState): Promise<boolean> {
    if (context.stash) this._stash = context.stash
    if (!this._conditions.reached(context)) return false
    if (this._target !== '*') return this._applyPerBlock(context)
    const acted = await this._applyPerMessage(context)
    if (acted) repairAlternation(context.messages)
    return acted
  }

  /**
   * Message-level execution for target `'*'`, on the messages {@link _getEligibleMessages} returns. `apply` restores
   * alternation afterwards.
   */
  protected abstract _applyPerMessage(context: ContextState): Promise<boolean>

  /** Per-block execution: walk each message, transform individual blocks above threshold. */
  private async _applyPerBlock(context: ContextState): Promise<boolean> {
    const { messages, agent, invocationContext } = context
    const toolNameMap = buildToolNameMap(messages)
    const threshold = this._conditions.thresholdTokens(agent)
    let acted = false
    for (const message of this._candidates(messages, toolNameMap)) {
      // Without the eager hook, message 0 is the task and the last message is one the model has not yet responded to.
      if (!this._runsEagerly && (message === messages[0] || message === messages.at(-1))) continue
      if (await this._transformBlocks(message, messages, toolNameMap, threshold, agent, invocationContext)) acted = true
    }
    return acted
  }

  /** Matching messages outside `preserveRecent`, without pinned ones, in history order. */
  private _candidates(messages: Message[], toolNameMap: Map<string, string>): Message[] {
    const matching = messages.filter((message) => this._matcher.matchesMessage(message, toolNameMap))
    return this._conditions
      .withoutPreserved(matching)
      .filter((message) => !isPinned(messages, messages.indexOf(message)))
  }

  /** Messages outside `preserveRecent` and larger than `blockThreshold`, excluding message 0 and pinned messages. */
  protected async _getEligibleMessages(context: ContextState): Promise<Message[]> {
    const { messages, agent } = context
    const eligible = this._candidates(messages, buildToolNameMap(messages)).filter((message) => message !== messages[0])
    const threshold = this._conditions.thresholdTokens(agent)
    if (threshold === undefined) return eligible

    const sizes = await Promise.all(eligible.map((message) => agent.model.countTokens([message])))
    return eligible.filter((_message, index) => sizes[index]! > threshold)
  }

  /** Removes messages with their tool pairs and leaves a placeholder at the gap; `apply` restores alternation. */
  protected _removeMessages(messages: Message[], toRemove: Message[], textFor: PlaceholderText): Promise<boolean> {
    return removeMessages(messages, toRemove, textFor, { name: this.name, method: this._method, stash: this._stash })
  }

  /** The placeholder this strategy leaves for a block it replaced. */
  protected _placeholder(preview: string, stashRef: string | undefined): TextBlock {
    return offloadPlaceholder(this._method, preview, stashRef)
  }

  /** Whether a block in `message` is content this strategy may replace. */
  private _isOffloadable(block: ContentBlock, message: Message, toolNameMap: Map<string, string>): boolean {
    if (block instanceof ToolUseBlock || block instanceof CachePointBlock || block instanceof ReasoningBlock) {
      return false
    }
    if (isOffloaded(block) || (block instanceof TextBlock && block.text.trim() === '')) return false
    if (block instanceof ToolResultBlock && this._stash && toolNameMap.get(block.toolUseId) === RETRIEVAL_TOOL_NAME) {
      return false
    }
    return this._matcher.matchesBlock(block, message, toolNameMap)
  }

  /** Process eligible blocks in a message, replacing each one larger than `threshold` tokens, or every one if unset. */
  protected async _transformBlocks(
    message: Message,
    messages: Message[],
    toolNameMap: Map<string, string>,
    threshold: number | undefined,
    agent: LocalAgent,
    invocationContext?: InvocationContext
  ): Promise<boolean> {
    let acted = false
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]!
      if (!this._isOffloadable(block, message, toolNameMap)) continue

      const tokens = await agent.model.countTokens([new Message({ role: message.role, content: [block] })])
      // The token heuristic counts media as 0, so unmeasured media is never treated as within the threshold.
      if (threshold !== undefined && tokens <= threshold && !(tokens === 0 && isMediaBlock(block))) continue

      const stashRef = this._stash ? await this._stash.ensureStashed(block, message, blockIndex) : undefined
      const replacement = await this._replaceBlock(block, tokens, message, agent, stashRef, invocationContext)
      if (replacement && replacement !== block) {
        ;(message.content as unknown[])[blockIndex] = replacement
        acted = true
      }
    }
    if (acted) this._warnUnconditional()
    return acted
  }

  /**
   * Transform a block. Return the replacement, or null to skip.
   * `stashRef` is the reference the original is retrievable under, or `undefined` when there is no stash.
   */
  protected abstract _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    agent: LocalAgent,
    stashRef: string | undefined,
    invocationContext?: InvocationContext
  ): Promise<ContentBlock | null>
}

// --- Emergency truncation strategy ---

const EMERGENCY_REMOVAL_RATIO = 0.2

/**
 * Last-resort strategy that recomputes utilization and drops the oldest 20% of messages
 * when the context window is still overflowing after all user-configured strategies have run.
 * Appended internally by ContextManager — not part of the public builder API.
 * Pins are ignored so an all-pinned overflow is still recoverable.
 *
 * TODO: add a ContextManagerConfig flag to disable this for users who want full control.
 *
 * @internal
 */
export class EmergencyTruncateStrategy implements ContextStrategy {
  readonly name = 'offload:emergency-truncate'

  private _stash: Stash | undefined

  init(_agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
  }

  async apply(context: ContextState): Promise<boolean> {
    const { messages, agent } = context
    if (messages.length <= 3) return false
    if (context.stash) this._stash = context.stash
    if (!context.overflow && agent.model.estimateUtilization(await agent.model.countTokens(messages)) < 1.0) {
      return false
    }

    const removable = messages.slice(1)
    let removeCount = Math.max(1, Math.floor(removable.length * EMERGENCY_REMOVAL_RATIO))
    // Cut just before an assistant message, which holds no tool result to orphan and never merges into message 0.
    if (removable[removeCount]?.role !== 'assistant') removeCount += 1
    const remover = { name: this.name, method: 'truncate' as const, stash: this._stash }
    const textFor = async ({ length }: Message[]): Promise<string> => formatElided(length)
    if (!(await removeMessages(messages, removable.slice(0, removeCount), textFor, remover))) return false
    repairAlternation(messages)
    return true
  }
}
