/**
 * Content-inspection helpers shared by compression methods and the content router.
 *
 * These helpers classify messages and content blocks, extract text for previews,
 * and slice text down to a token budget. They centralize the block-type checks so
 * individual methods stay small.
 */

import { Message, TextBlock, ToolUseBlock, ToolResultBlock, JsonBlock } from '../types/messages.js'
import type { ContentBlock, ToolResultContent } from '../types/messages.js'
import { ImageBlock, VideoBlock, DocumentBlock } from '../types/media.js'
import type { PreviewMode } from './types.js'

/** Approximate characters per token, matching the heuristic used elsewhere in the SDK. */
export const CHARS_PER_TOKEN = 4

/** Categories the content router can dispatch on. */
export type ContentCategory =
  | 'toolResults'
  | 'toolResultErrors'
  | 'assistantMessages'
  | 'userMessages'
  | 'images'
  | 'documents'
  | 'code'
  | 'json'

/** Returns `true` if the message contains a tool-use block. */
export function hasToolUse(message: Message): boolean {
  return message.content.some((b) => b instanceof ToolUseBlock)
}

/** Returns the tool-result blocks in a message, if any. */
export function toolResultBlocks(message: Message): ToolResultBlock[] {
  return message.content.filter((b): b is ToolResultBlock => b instanceof ToolResultBlock)
}

/** Returns `true` if the message carries a failed tool result. */
export function isToolResultError(message: Message): boolean {
  return toolResultBlocks(message).some((b) => b.status === 'error')
}

/** Returns `true` if the message contains an image block (top-level or inside a tool result). */
export function hasImage(message: Message): boolean {
  if (message.content.some((b) => b instanceof ImageBlock)) return true
  return toolResultBlocks(message).some((tr) => tr.content.some((c) => c instanceof ImageBlock))
}

/** Returns `true` if the message contains a document block. */
export function hasDocument(message: Message): boolean {
  if (message.content.some((b) => b instanceof DocumentBlock)) return true
  return toolResultBlocks(message).some((tr) => tr.content.some((c) => c instanceof DocumentBlock))
}

/**
 * Heuristically classify a message into the most specific routing category.
 *
 * Order matters: errors are checked before generic tool results, and media
 * categories before role categories, so the most specific route wins.
 */
export function categorize(message: Message): ContentCategory {
  if (isToolResultError(message)) return 'toolResultErrors'
  if (hasImage(message)) return 'images'
  if (hasDocument(message)) return 'documents'
  if (toolResultBlocks(message).length > 0) return 'toolResults'
  if (message.role === 'assistant') return 'assistantMessages'
  return 'userMessages'
}

/** Extracts a flat text representation of a content block for previews. */
function blockText(block: ContentBlock | ToolResultContent): string {
  if (block instanceof TextBlock) return block.text
  if (block instanceof JsonBlock) return JSON.stringify(block.json, null, 2)
  if (block instanceof ToolResultBlock) return block.content.map(blockText).join('\n')
  if (block instanceof ToolUseBlock) return `${block.name}(${JSON.stringify(block.input)})`
  if (block instanceof ImageBlock) return `[image: ${block.format}]`
  if (block instanceof VideoBlock) return `[video: ${block.format}]`
  if (block instanceof DocumentBlock) return `[document: ${block.format}, ${block.name}]`
  return ''
}

/** Extracts a flat text representation of an entire message. */
export function messageText(message: Message): string {
  return message.content
    .map(blockText)
    .filter((t) => t.length > 0)
    .join('\n')
}

/**
 * Slice text down to a token budget using one of the preview modes.
 *
 * - `head`: keep the first N tokens.
 * - `tail`: keep the last N tokens.
 * - `head-tail`: keep the first N/2 and last N/2 tokens, eliding the middle.
 */
export function previewText(text: string, mode: PreviewMode, tokens: number): string {
  const maxChars = Math.max(0, tokens) * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  if (mode === 'head') return text.slice(0, maxChars)
  if (mode === 'tail') return text.slice(text.length - maxChars)
  const half = Math.floor(maxChars / 2)
  const elided = text.length - maxChars
  return `${text.slice(0, half)}\n... [${elided.toLocaleString()} chars elided] ...\n${text.slice(text.length - half)}`
}
