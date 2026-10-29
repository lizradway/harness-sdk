/**
 * Drop strategy — removes matching content from the context window entirely.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextState } from '../../types.js'
import { BaseOffloadStrategy, offloadPlaceholder } from './base.js'
import type { OffloadConditions } from './conditions.js'
import { isMediaBlock, mediaKind, type OffloadTarget } from './target.js'

export const DROPPED_MARKER = '[Dropped]'

export class DropStrategy extends BaseOffloadStrategy {
  constructor(target?: OffloadTarget, conditions?: OffloadConditions) {
    super('offload:drop', target, conditions)
  }

  protected _withConditions(conditions: OffloadConditions): DropStrategy {
    return new DropStrategy(this._target, conditions)
  }

  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const eligible = await this._getEligibleMessages(context)
    return this._removeMessages(
      context.messages,
      eligible,
      ({ length }) => `[Dropped: ${length} ${length === 1 ? 'message' : 'messages'}]`
    )
  }

  protected async _replaceBlock(
    block: ContentBlock,
    _tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRef: string | undefined
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}> | dropped tool result from context window`)
      return block.withContent([offloadPlaceholder(DROPPED_MARKER, stashRef)])
    }
    if (isMediaBlock(block)) {
      logger.debug(`trackingId=<${message.trackingId}> | dropped media block from context window`)
      // A bare marker reads to the model as media that never arrived, so it doubts what it saw.
      return offloadPlaceholder(`[Dropped: ${mediaKind(block)}, removed from context after it was viewed]`, stashRef)
    }
    logger.debug(`trackingId=<${message.trackingId}> | dropped block from context window`)
    return offloadPlaceholder(DROPPED_MARKER, stashRef)
  }
}
