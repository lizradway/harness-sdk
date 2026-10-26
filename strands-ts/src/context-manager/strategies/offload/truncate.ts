/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextState } from '../../types.js'
import {
  PREVIEW_HEAD_SHARE,
  TRUNCATED_PREFIX,
  resolvePreviewTokens,
  truncateToolResultBlock,
  truncateTextBlock,
  type TruncateConfig,
} from '../../methods/truncate.js'
import { formatStashRefs, type Stash } from '../../stash.js'
import {
  BaseOffloadStrategy,
  buildToolNameMap,
  formatOffloaded,
  insertMarker,
  repairAlternation,
  spliceWithPairs,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

export class TruncateStrategy extends BaseOffloadStrategy {
  private readonly _truncateConfig: TruncateConfig
  private readonly _previewTokens: number

  constructor(target?: OffloadTarget, config?: TruncateConfig, conditions?: OffloadConditions) {
    super('offload:truncate', target, conditions)
    this._truncateConfig = config ?? {}
    this._previewTokens = resolvePreviewTokens(this._truncateConfig)

    // A percent needs the context window, so init checks it.
    if (this._threshold && !this._threshold.isShare) {
      this._checkThresholdExceedsPreview(this._threshold.value, String(this._threshold.value))
    }
  }

  /**
   * Checks a percent threshold against `previewTokens`, then initializes the strategy.
   *
   * @param agent - The agent this strategy is attached to
   * @param stash - The stash offloaded content is stored in
   * @throws Error when a percent `threshold` of the context window is no larger than `previewTokens`, or
   *   `utilization` is a token count larger than the model's `contextWindowLimit`
   */
  override init(agent: LocalAgent, stash?: Stash): void {
    if (this._threshold?.isShare) {
      const tokens = this._resolveThreshold(agent) ?? 0
      this._checkThresholdExceedsPreview(tokens, `${tokens} tokens of the context window`)
    }
    super.init(agent, stash)
  }

  private _checkThresholdExceedsPreview(tokens: number, shown: string): void {
    if (this._actsOnMessages || tokens > this._previewTokens) return
    throw new Error(
      `threshold (${shown}) must be greater than previewTokens (${this._previewTokens}) to ensure truncation converges; raise threshold or lower previewTokens`
    )
  }

  /**
   * Middle-out: keeps the oldest and newest eligible messages within the preview budget and elides the rest. With a
   * `threshold`, shortens each eligible message in place instead.
   */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 1) return false
    if (this._threshold) return this._shortenEach(context)

    // Skipping earlier markers lets a pass with nothing new to elide return false instead of re-eliding them.
    const eligible = (await this._getEligibleMessages(context)).filter((message) => !hasElisionMarker(message))
    const middle = await this._selectMiddle(eligible, context.agent)
    if (middle.length === 0) return false

    const { removed, lowestIndex } = spliceWithPairs(messages, middle)
    if (removed === 0) return false

    insertMarker(messages, lowestIndex, this._makeRemovalMarker(removed))
    repairAlternation(messages)
    return true
  }

  /** Previews each block over `previewTokens` in the eligible messages, leaving the newest message alone. */
  private async _shortenEach(context: ContextState): Promise<boolean> {
    const { messages, agent } = context
    const toolNameMap = buildToolNameMap(messages)
    let acted = false
    for (const message of await this._getEligibleMessages(context)) {
      if (message === messages.at(-1)) continue
      if (await this._transformBlocks(message, messages, toolNameMap, this._previewTokens, agent)) acted = true
    }
    return acted
  }

  protected override _makeRemovalMarker(count: number): string {
    return `[... ${count} ${count === 1 ? 'message' : 'messages'} elided ...]`
  }

  /** Skips blocks that already hold a truncation preview, so previews are never re-truncated. */
  protected override _blockMatchesTarget(
    block: ContentBlock,
    message: Message,
    toolNameMap: Map<string, string>
  ): boolean {
    return !isTruncated(block) && super._blockMatchesTarget(block, message, toolNameMap)
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRefs: string[]
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | truncated tool result`)
      const truncated = truncateToolResultBlock(block, this._truncateConfig)
      if (truncated !== block) {
        return appendStashRefs(truncated, stashRefs)
      }
      return truncated
    }
    if (block instanceof TextBlock) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | truncated text block`)
      const truncated = truncateTextBlock(block, this._truncateConfig)
      const refs = formatStashRefs(stashRefs)
      return refs ? new TextBlock(`${truncated.text}\n\n[Stashed]${refs}`) : truncated
    }
    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return new TextBlock(formatOffloaded(block, tokens, stashRefs))
  }

  /** The eligible messages between the head and tail kept within the preview token budget. */
  private async _selectMiddle(eligible: Message[], agent: LocalAgent): Promise<Message[]> {
    const headBudget = this._previewTokens * PREVIEW_HEAD_SHARE[this._truncateConfig.preview ?? 'headTail']
    const headCount = await countWithinBudget(eligible, headBudget, agent)
    const rest = eligible.slice(headCount)
    const tailCount = await countWithinBudget([...rest].reverse(), this._previewTokens - headBudget, agent)
    return rest.slice(0, rest.length - tailCount)
  }
}

/** How many leading messages fit within `budget` tokens. */
async function countWithinBudget(messages: Message[], budget: number, agent: LocalAgent): Promise<number> {
  let total = 0
  let count = 0
  for (const message of messages) {
    total += await agent.model.countTokens([message])
    if (total > budget) break
    count++
  }
  return count
}

const ELISION_MARKER = /^\[\.\.\. \d+ messages? elided \.\.\.\]$/

function hasElisionMarker(message: Message): boolean {
  return message.content.some((block) => block instanceof TextBlock && ELISION_MARKER.test(block.text))
}

/** Matches on the text prefix, so content that genuinely starts with it is also treated as truncated. */
function isTruncated(block: ContentBlock): boolean {
  if (block instanceof TextBlock) return block.text.startsWith(TRUNCATED_PREFIX)
  if (!(block instanceof ToolResultBlock)) return false
  const firstText = block.content.find((content) => content instanceof TextBlock)
  return firstText?.text.startsWith(TRUNCATED_PREFIX) ?? false
}

function appendStashRefs(block: ToolResultBlock, stashRefs: string[]): ToolResultBlock {
  const refs = formatStashRefs(stashRefs)
  if (!refs) return block

  const content = [...block.content]
  for (let index = 0; index < content.length; index++) {
    const item = content[index]!
    if (item instanceof TextBlock) {
      content[index] = new TextBlock(`${item.text}\n\n[Stashed]${refs}`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content,
      })
    }
  }
  return block
}
