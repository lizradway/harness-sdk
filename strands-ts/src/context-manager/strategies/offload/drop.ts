/**
 * Drop strategy — removes matching content from the context window entirely.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import { formatStashRefs } from '../../stash.js'
import { BaseOffloadStrategy, isMediaBlock, mediaKind } from './base.js'
import type { OffloadConditions, OffloadTarget } from './base.js'

export const DROPPED_MARKER = '[Dropped]'

export class DropStrategy extends BaseOffloadStrategy {
  constructor(target?: OffloadTarget, conditions?: OffloadConditions) {
    super('offload:drop', target, conditions)
  }

  protected _withConditions(conditions: OffloadConditions): DropStrategy {
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
    stashRefs: string[]
  ): Promise<ContentBlock | null> {
    const refs = formatStashRefs(stashRefs)
    const marker = `${DROPPED_MARKER}${refs}`

    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}> | dropped tool result from context window`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content: [new TextBlock(marker)],
      })
    }
    if (isMediaBlock(block)) {
      logger.debug(`trackingId=<${message.trackingId}> | dropped media block from context window`)
      // A bare marker reads to the model as media that never arrived, so it doubts what it saw.
      return new TextBlock(`[Dropped: ${mediaKind(block)}, removed from context after it was viewed]${refs}`)
    }
    logger.debug(`trackingId=<${message.trackingId}> | dropped block from context window`)
    return new TextBlock(marker)
  }
}
