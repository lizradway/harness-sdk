/**
 * Message-rewriting helpers used by compression methods.
 *
 * These helpers shrink the textual payload of a message while preserving the
 * structure that keeps a conversation valid: tool-use blocks, tool-result ids
 * and statuses, and message roles are left intact so tool pairs stay matched.
 */

import { Message, TextBlock, ToolResultBlock, JsonBlock } from '../types/messages.js'
import type { ContentBlock, ToolResultContent } from '../types/messages.js'
import { ImageBlock, VideoBlock, DocumentBlock } from '../types/media.js'

/** A transformation applied to a piece of textual content. */
export type TextTransform = (text: string) => string

/** Render a media block as a short placeholder string. */
function mediaPlaceholder(block: ImageBlock | VideoBlock | DocumentBlock): string {
  if (block instanceof ImageBlock) return `[image: ${block.format}]`
  if (block instanceof VideoBlock) return `[video: ${block.format}]`
  return `[document: ${block.format}, ${block.name}]`
}

/** Apply a text transform to a single tool-result content block. */
function transformToolResultContent(block: ToolResultContent, fn: TextTransform): ToolResultContent {
  if (block instanceof TextBlock) return new TextBlock(fn(block.text))
  if (block instanceof JsonBlock) return new TextBlock(fn(JSON.stringify(block.json, null, 2)))
  if (block instanceof ImageBlock || block instanceof VideoBlock || block instanceof DocumentBlock) {
    return new TextBlock(mediaPlaceholder(block))
  }
  return block
}

/** Apply a text transform to a single top-level content block. */
function transformBlock(block: ContentBlock, fn: TextTransform): ContentBlock {
  if (block instanceof TextBlock) return new TextBlock(fn(block.text))
  if (block instanceof ImageBlock || block instanceof VideoBlock || block instanceof DocumentBlock) {
    return new TextBlock(mediaPlaceholder(block))
  }
  if (block instanceof ToolResultBlock) {
    return new ToolResultBlock({
      toolUseId: block.toolUseId,
      status: block.status,
      content: block.content.map((c) => transformToolResultContent(c, fn)),
    })
  }
  // Tool-use blocks and any other block types are preserved verbatim so tool
  // pairs and reasoning signatures stay valid.
  return block
}

/**
 * Rebuild a message, applying `fn` to every textual payload it carries.
 *
 * Tool-use blocks are preserved unchanged; tool-result blocks keep their id and
 * status while their content text is transformed; media blocks become short
 * placeholders. The message role and metadata are preserved.
 *
 * @param message - The message to rewrite.
 * @param fn - The transform applied to each piece of text.
 * @returns A new message with transformed content.
 */
export function transformMessageText(message: Message, fn: TextTransform): Message {
  return new Message({
    role: message.role,
    content: message.content.map((b) => transformBlock(b, fn)),
    ...(message.metadata !== undefined && { metadata: message.metadata }),
  })
}

/** Returns `true` if a message carries only tool-use / tool-result blocks (no free text). */
export function isToolOnly(message: Message): boolean {
  return message.content.every((b) => b.type === 'toolUseBlock' || b.type === 'toolResultBlock')
}
