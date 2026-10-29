/**
 * Base offload strategy: target routing, eager hooks, preserveRecent, and the shared
 * per-block and message-level execution paths.
 */

import { logger } from '../../../logging/logger.js'
import { MessageAddedEvent } from '../../../hooks/events.js'
import {
  isOffloaded,
  Message,
  TextBlock,
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
import { formatElided } from '../../methods/truncate.js'
import { insertMarker, repairAlternation, spliceWithPairs } from '../../message-trimming.js'
import { buildToolNameMap, OffloadTargetMatcher, type OffloadTarget } from './target.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'

/**
 * Conditions that determine when an offload strategy fires.
 *
 * Granularity is determined by which conditions are set:
 * - `threshold` only → per-block, eager (act on each block above this size on message arrival)
 * - `utilization` only → message-level (remove/summarize oldest messages when utilization exceeded)
 * - Both → message-level, targeting only messages with blocks over the threshold
 *
 * When multiple strategies target the same content, they don't conflict — strategies
 * run as an ordered pipeline, and once an earlier strategy shrinks a block, it falls
 * below the next strategy's threshold and gets skipped automatically.
 *
 * @experimental
 */
export interface OffloadConditions {
  /** Token threshold above which individual blocks are offloaded. */
  threshold?: number

  /** Context utilization ratio (0-1+) above which the strategy fires. */
  utilization?: number

  /**
   * How many recent matching messages to leave untouched.
   * - Integer (1 or above): absolute count of messages to preserve.
   * - Decimal (between 0 and 1 exclusive): ratio of matching messages to preserve (e.g. 0.7 = keep 70%).
   */
  preserveRecent?: number
}

/**
 * Intermediate builder result that allows chaining `.when()` conditions.
 * Also implements `ContextStrategy` directly so it can be used without `.when()`.
 */
export interface OffloadStrategyBuilder extends ContextStrategy {
  /** Add conditions that determine when this strategy fires. */
  when(conditions: OffloadConditions): ContextStrategy
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

/** Shared offload logic: target routing, eager hooks, preserveRecent. */
export abstract class BaseOffloadStrategy implements ContextStrategy {
  abstract readonly name: string

  protected readonly _matcher: OffloadTargetMatcher
  protected readonly _threshold: number | undefined
  protected readonly _utilizationThreshold: number | undefined
  protected readonly _preserveRecent: number
  protected _stash: Stash | undefined

  constructor(target?: OffloadTarget, conditions?: OffloadConditions) {
    this._matcher = new OffloadTargetMatcher(target)
    this._threshold = finiteOrUndefined(conditions?.threshold)
    this._utilizationThreshold = finiteOrUndefined(conditions?.utilization)
    this._preserveRecent = finiteOrUndefined(conditions?.preserveRecent) ?? 0
  }

  /** The target this strategy was built with, for `when()` to rebuild it. */
  protected get _target(): OffloadTarget | undefined {
    return this._matcher.target
  }

  /** Whether this strategy operates at message-level (batch) vs per-block. */
  protected get _isMessageLevel(): boolean {
    return this._utilizationThreshold !== undefined
  }

  init(agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
    if (this._isMessageLevel) return
    if (this._preserveRecent > 0) return
    agent.addHook(MessageAddedEvent, async (event) => {
      const messages = event.agent.messages
      const index = messages.indexOf(event.message)
      if (index >= 0 && isPinned(messages, index)) return
      await this._transformBlocks(event.message, messages, buildToolNameMap(messages), event.agent)
    })
  }

  async apply(context: ContextState): Promise<boolean> {
    if (context.stash) this._stash = context.stash
    if (this._isMessageLevel) {
      if (!context.overflow && context.utilization < this._utilizationThreshold!) return false
      return this._applyPerMessage(context)
    }

    return this._applyPerBlock(context)
  }

  /** Per-block execution: walk each message, transform individual blocks above threshold. */
  private async _applyPerBlock(context: ContextState): Promise<boolean> {
    const { messages, agent, invocationContext } = context
    const toolNameMap = buildToolNameMap(messages)
    let acted = false
    for (const message of this._matcher.oldestMatches(messages, this._preserveRecent, toolNameMap)) {
      if (isPinned(messages, messages.indexOf(message))) continue
      if (await this._transformBlocks(message, messages, toolNameMap, agent, invocationContext)) acted = true
    }
    return acted
  }

  /** Message-level execution: remove eligible messages with pair safety. */
  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 1) return false

    const eligible = await this._getEligibleMessages(context)
    if (eligible.length === 0) return false

    return this._removeMessages(messages, eligible, (count) => this._makeRemovalMarker(count))
  }

  /**
   * Removes messages with their tool pairs, leaves the marker `markerFor` returns at the gap, and
   * restores alternation. Returns whether anything was removed.
   */
  protected async _removeMessages(
    messages: Message[],
    toRemove: Message[],
    markerFor: (removedCount: number) => string | null
  ): Promise<boolean> {
    const { removed, lowestIndex } = spliceWithPairs(messages, toRemove)
    if (removed.length === 0) return false

    const marker = markerFor(removed.length)
    if (marker !== null) {
      insertMarker(messages, lowestIndex, offloadPlaceholder(marker, await this._stashRemoved(removed)))
    }

    repairAlternation(messages)
    return true
  }

  /** Stores removed messages for retrieval; a failed write leaves the marker without a reference. */
  private async _stashRemoved(removed: Message[]): Promise<string | undefined> {
    if (!this._stash) return undefined
    try {
      return await this._stash.storeRemoved(removed)
    } catch (error) {
      logger.warn(`strategy=<${this.name}>, error=<${error}> | failed to stash removed messages`)
      return undefined
    }
  }

  /** Override to insert a marker when messages are removed. Return null for no marker. */
  protected _makeRemovalMarker(_count: number): string | null {
    return null
  }

  /** Whether a block is eligible for offload given the current target and filters. */
  protected _blockMatchesTarget(block: ContentBlock, message: Message, toolNameMap: Map<string, string>): boolean {
    if (
      block instanceof ToolUseBlock ||
      block instanceof CachePointBlock ||
      block instanceof ReasoningBlock ||
      isOffloaded(block)
    ) {
      return false
    }
    if (block instanceof TextBlock) return this._matcher.matchesText(message)
    if (block instanceof ToolResultBlock) {
      if (this._stash && toolNameMap.get(block.toolUseId) === RETRIEVAL_TOOL_NAME) return false
      return this._matcher.matchesToolResult(block, toolNameMap)
    }
    return this._matcher.matchesAll
  }

  /** Process eligible blocks in a message. */
  protected async _transformBlocks(
    message: Message,
    messages: Message[],
    toolNameMap: Map<string, string>,
    agent: LocalAgent,
    invocationContext?: InvocationContext
  ): Promise<boolean> {
    const effectiveThreshold = this._threshold ?? 0
    let acted = false
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]!
      if (!this._blockMatchesTarget(block, message, toolNameMap)) continue

      const tokens = await this._countBlockTokens(block, message, agent)
      if (tokens <= effectiveThreshold) continue

      const stashRef = this._stash ? await this._stash.ensureStashed(block, message, blockIndex) : undefined
      const replacement = await this._replaceBlock(block, tokens, message, agent, stashRef, invocationContext)
      if (replacement && replacement !== block) {
        ;(message.content as unknown[])[blockIndex] = replacement
        acted = true
      }
    }
    return acted
  }

  /** Collect eligible messages for message-level operations, respecting preserveRecent, head-pin, and threshold. */
  protected async _getEligibleMessages(context: ContextState): Promise<Message[]> {
    const { messages, agent } = context
    const toolNameMap = buildToolNameMap(messages)
    const candidates = this._matcher.oldestMatches(messages, this._preserveRecent, toolNameMap).filter((message) => {
      const index = messages.indexOf(message)
      return index > 0 && !isPinned(messages, index)
    })
    if (this._threshold === undefined) return candidates

    const eligible: Message[] = []
    for (const message of candidates) {
      if (await this._hasOversizedBlock(message, toolNameMap, agent)) eligible.push(message)
    }
    return eligible
  }

  /** Whether any block the target covers exceeds the threshold. */
  private async _hasOversizedBlock(
    message: Message,
    toolNameMap: Map<string, string>,
    agent: LocalAgent
  ): Promise<boolean> {
    for (const block of message.content) {
      if (!this._blockMatchesTarget(block, message, toolNameMap)) continue
      if ((await this._countBlockTokens(block, message, agent)) > this._threshold!) return true
    }
    return false
  }

  private _countBlockTokens(block: ContentBlock, message: Message, agent: LocalAgent): Promise<number> {
    return agent.model.countTokens([new Message({ role: message.role, content: [block] })])
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

/**
 * The text block that stands in for offloaded content: the preview, followed by the stash reference
 * when the original is retrievable, with both recorded in `offloaded`.
 *
 * @internal
 */
export function offloadPlaceholder(preview: string, stashRef: string | undefined): TextBlock {
  if (stashRef === undefined) return new TextBlock(preview, { offloaded: { preview } })
  return new TextBlock(`${preview} [ref: ${stashRef}]`, { offloaded: { preview, ref: stashRef } })
}

// --- Emergency truncation strategy ---

const EMERGENCY_REMOVAL_RATIO = 0.2

/**
 * Last-resort strategy that recomputes utilization and drops the oldest 20% of messages
 * when the context window is still overflowing after all user-configured strategies have run.
 * Appended internally by ContextManager — not part of the public builder API.
 *
 * TODO: add a ContextManagerConfig flag to disable this for users who want full control.
 *
 * @internal
 */
export class EmergencyTruncateStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:emergency-truncate'

  constructor() {
    super('*')
  }

  override init(_agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
  }

  override async apply(context: ContextState): Promise<boolean> {
    if (context.messages.length <= 3) return false
    if (!context.overflow) {
      const tokens = await context.agent.model.countTokens(context.messages)
      const utilization = context.agent.model.estimateUtilization(tokens)
      if (utilization < 1.0) return false
    }
    return this._applyPerMessage(context)
  }

  /** Drop the oldest 20% of non-head messages each pass. */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 3) return false

    const removable = messages.filter((_, index) => index > 0)
    let removeCount = Math.max(1, Math.floor(removable.length * EMERGENCY_REMOVAL_RATIO))
    // Cut just before an assistant message, which holds no tool result to orphan and never merges into message 0.
    if (removable[removeCount]?.role !== 'assistant') removeCount += 1
    const toRemove = removable.slice(0, removeCount)

    return this._removeMessages(messages, toRemove, (count) => this._makeRemovalMarker(count))
  }

  protected override _makeRemovalMarker(count: number): string {
    return formatElided(count)
  }

  protected async _replaceBlock(): Promise<ContentBlock | null> {
    return null
  }
}
