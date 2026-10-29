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
import { DROPPED_MARKER, formatDroppedMedia, formatDroppedMessages } from '../../placeholder.js'
import { BaseOffloadStrategy } from './base.js'
import type { OffloadConditions } from './conditions.js'
import { mediaKind, type OffloadTarget } from './target.js'

export class DropStrategy extends BaseOffloadStrategy {
  constructor(target?: OffloadTarget, conditions?: OffloadConditions) {
    super('drop', target, conditions)
  }

  protected _withConditions(conditions: OffloadConditions): DropStrategy {
    return new DropStrategy(this._target, conditions)
  }

  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const eligible = await this._getEligibleMessages(context)
    return this._removeMessages(context.messages, eligible, ({ length }) => formatDroppedMessages(length))
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
      return block.withContent([this._placeholder(DROPPED_MARKER, stashRef)])
    }
    const kind = mediaKind(block)
    if (kind) {
      logger.debug(`trackingId=<${message.trackingId}> | dropped media block from context window`)
      return this._placeholder(formatDroppedMedia(kind), stashRef)
    }
    logger.debug(`trackingId=<${message.trackingId}> | dropped block from context window`)
    return this._placeholder(DROPPED_MARKER, stashRef)
  }
}
