/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, OffloadedBlock, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy } from '../../types.js'
import { truncateToolResultBlock, truncateTextBlock, type TruncateConfig } from '../../methods/truncate.js'
import { BaseOffloadStrategy, offloadPlaceholder, type OffloadConditions, type OffloadTarget } from './base.js'

export class TruncateStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:truncate'

  private readonly _truncateConfig: TruncateConfig

  constructor(target?: OffloadTarget, config?: TruncateConfig, conditions?: OffloadConditions) {
    super(target, conditions)
    this._truncateConfig = config ?? {}

    const previewTokens =
      typeof this._truncateConfig.previewTokens === 'number' && Number.isFinite(this._truncateConfig.previewTokens)
        ? this._truncateConfig.previewTokens
        : 1000
    if (
      conditions?.threshold !== undefined &&
      Number.isFinite(conditions.threshold) &&
      conditions.threshold <= previewTokens
    ) {
      throw new Error(
        `threshold (${conditions.threshold}) must be greater than previewTokens (${previewTokens}) to ensure truncation converges`
      )
    }
  }

  when(conditions: OffloadConditions): ContextStrategy {
    return new TruncateStrategy(this._target, this._truncateConfig, conditions)
  }

  protected override _makeRemovalMarker(count: number): string {
    return `[... ${count} ${count === 1 ? 'message' : 'messages'} elided ...]`
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRef: string | undefined
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | truncated tool result`)
      const truncated = truncateToolResultBlock(block, this._truncateConfig)
      if (truncated !== block && stashRef !== undefined) {
        return markStashed(truncated, stashRef)
      }
      return truncated
    }
    if (block instanceof TextBlock) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | truncated text block`)
      const truncated = truncateTextBlock(block, this._truncateConfig)
      if (stashRef === undefined) return truncated
      return new OffloadedBlock({ ref: stashRef, preview: `${truncated.text}\n\n[Stashed]` })
    }
    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return offloadPlaceholder(`[Offloaded: ~${tokens} tokens]`, stashRef)
  }
}

/** Turns the preview text item of a truncated tool result into the {@link OffloadedBlock} that references the original. */
function markStashed(block: ToolResultBlock, stashRef: string): ToolResultBlock {
  const index = block.content.findIndex((item) => item instanceof TextBlock)
  if (index === -1) return block

  const content = [...block.content]
  const preview = (content[index] as TextBlock).text
  content[index] = new OffloadedBlock({ ref: stashRef, preview: `${preview}\n\n[Stashed]` })
  return new ToolResultBlock({ toolUseId: block.toolUseId, status: block.status, content })
}
