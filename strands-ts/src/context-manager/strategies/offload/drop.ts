/**
 * Drop strategy — removes matching content from the context window entirely.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy } from '../../types.js'
import { BaseOffloadStrategy, offloadPlaceholder } from './base.js'
import type { OffloadConditions } from './base.js'

export const DROPPED_MARKER = '[Dropped]'

export class DropStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:drop'

  when(conditions: OffloadConditions): ContextStrategy {
    return new DropStrategy(this._target, conditions)
  }

  protected override _makeRemovalMarker(count: number): string {
    return `[Dropped: ${count} ${count === 1 ? 'message' : 'messages'}]`
  }

  protected async _replaceBlock(
    block: ContentBlock,
    _tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRef: string | undefined
  ): Promise<ContentBlock | null> {
    const marker = offloadPlaceholder(DROPPED_MARKER, stashRef)

    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}> | dropped tool result from context window`)
      return block.withContent([marker])
    }
    logger.debug(`trackingId=<${message.trackingId}> | dropped block from context window`)
    return marker
  }
}
