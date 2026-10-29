/**
 * Truncate reduction method.
 *
 * Replaces content with a preview (head, tail, or head-tail).
 */

import { isOffloaded, JsonBlock, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { ToolResultContent } from '../../types/messages.js'
import { formatTruncated } from '../placeholder.js'

const DEFAULT_PREVIEW_TOKENS = 1000
const CHARS_PER_TOKEN = 4

/**
 * Configuration for the truncate method.
 *
 * @experimental
 */
export interface TruncateConfig {
  /**
   * Number of tokens to keep as preview text. Defaults to 1,000. Content that already fits is left unchanged. For
   * `Offload.truncate('*')` without a `blockThreshold`, the budget of whole messages kept at the head and tail; the
   * rest are replaced by one `[... N messages elided ...]` marker.
   */
  previewTokens?: number

  /**
   * Which portion of the text to keep as preview. Defaults to 'headTail'. For `Offload.truncate('*')` without a
   * `blockThreshold`, `'head'` keeps only the oldest messages and `'tail'` only the newest.
   */
  preview?: 'head' | 'tail' | 'headTail'
}

/**
 * Share of the preview budget kept from the head; the rest is kept from the tail.
 *
 * @internal
 */
export const PREVIEW_HEAD_SHARE = { head: 1, tail: 0, headTail: 0.6 } as const

/**
 * Resolves the preview token budget, defaulting to 1,000.
 *
 * @param config - Truncate configuration
 * @returns The preview token budget
 * @internal
 */
export function resolvePreviewTokens(config?: TruncateConfig): number {
  return typeof config?.previewTokens === 'number' && Number.isFinite(config.previewTokens)
    ? Math.max(0, config.previewTokens)
    : DEFAULT_PREVIEW_TOKENS
}

/**
 * Builds a preview of the given text (head, tail, or head-tail depending on config).
 *
 * @returns The preview string with truncation metadata header, or the original text if already within budget.
 */
export function buildPreview(fullText: string, blockCount: number, config?: TruncateConfig): string {
  const previewChars = resolvePreviewTokens(config) * CHARS_PER_TOKEN
  const previewMode = config?.preview ?? 'headTail'
  const totalChars = fullText.length

  if (totalChars <= previewChars) {
    return fullText
  }

  const headShare = PREVIEW_HEAD_SHARE[previewMode]
  const headChars = Math.floor(previewChars * headShare)
  const tailChars = previewChars - headChars
  const head = fullText.slice(0, headChars)
  const tail = tailChars > 0 ? fullText.slice(-tailChars) : ''
  const elided = totalChars - headChars - tailChars
  const marker = `[... ${elided.toLocaleString('en-US')} chars elided ...]`
  const preview = [head, marker, tail].filter(Boolean).join('\n\n')

  const result = formatTruncated(blockCount, Math.ceil(totalChars / CHARS_PER_TOKEN), preview)

  if (result.length >= totalChars) {
    return fullText
  }

  return result
}

/**
 * Splits a tool result into a preview of its textual content and the items kept as they are.
 * Text and JSON blocks are serialized into the preview. Opaque blocks (images, video, documents)
 * are kept untouched — their payloads cannot be meaningfully previewed as text.
 *
 * @returns The preview and the kept items, or `null` when nothing would be truncated.
 */
export function truncateToolResultBlock(
  block: ToolResultBlock,
  config?: TruncateConfig
): { preview: string; opaque: ToolResultContent[] } | null {
  const textual: string[] = []
  const opaque: ToolResultContent[] = []

  for (const content of block.content) {
    if (isOffloaded(content)) {
      opaque.push(content)
    } else if (content instanceof TextBlock) {
      textual.push(content.text)
    } else if (content instanceof JsonBlock) {
      textual.push(JSON.stringify(content.toJSON()))
    } else {
      opaque.push(content)
    }
  }

  if (textual.length === 0) {
    return null
  }

  const fullText = textual.join('\n')
  const preview = buildPreview(fullText, textual.length, config)

  return preview === fullText ? null : { preview, opaque }
}

/**
 * Creates a replacement TextBlock containing the truncated preview.
 * Returns the original block unchanged if preview would not reduce size.
 */
export function truncateTextBlock(block: TextBlock, config?: TruncateConfig): TextBlock {
  const preview = buildPreview(block.text, 1, config)
  if (preview === block.text) {
    return block
  }
  return new TextBlock(preview)
}
