/**
 * Offload targets: which blocks and messages a strategy acts on.
 */

import { logger } from '../../../logging/logger.js'
import { Message, OffloadedBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'

/**
 * Target for offload operations. This union is intentionally extensible — new
 * string-literal members can be added freely as new content categories emerge.
 *
 * - `"toolResults"` — all successful tool result blocks
 * - `"toolResultErrors"` — all failed tool result blocks
 * - `"assistantText"` — text blocks in assistant messages
 * - `"userText"` — text blocks in user messages (excluding tool results)
 * - `string[]` — tool results from specific tools, namespaced with `tool::` (e.g. `['tool::bash']`); prefix with `!` to exclude
 * - `"*"` — all content in the context window (tool results + text blocks)
 *
 * @experimental
 */
export type OffloadTarget = '*' | 'toolResults' | 'toolResultErrors' | 'assistantText' | 'userText' | string[]

const TOOL_PREFIX = 'tool::'

/**
 * Builds a toolUseId → toolName map from all assistant messages in the conversation.
 * Called once per apply() to avoid O(messages × toolResults) scanning.
 *
 * @internal
 */
export function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block instanceof ToolUseBlock) {
        map.set(block.toolUseId, block.name)
      }
    }
  }
  return map
}

/**
 * Whether a block is a text turn's content: the text itself, or the placeholder left where it was offloaded.
 *
 * @internal
 */
export function isTextContent(block: ContentBlock): boolean {
  return block instanceof TextBlock || block instanceof OffloadedBlock
}

/**
 * Matches blocks and messages against an {@link OffloadTarget}. A `string[]` target's `tool::`
 * entries are parsed once, here.
 *
 * @internal
 */
export class OffloadTargetMatcher {
  /** The target as the strategy was built with it. */
  readonly target: OffloadTarget | undefined

  private readonly _include: Set<string> | undefined
  private readonly _exclude: Set<string> | undefined

  constructor(target: OffloadTarget | undefined) {
    if (Array.isArray(target) && target.length === 0) {
      throw new Error('Empty array target matches nothing — provide at least one target')
    }
    this.target = target
    const filter = resolveToolFilter(target)
    this._include = filter.include
    this._exclude = filter.exclude
  }

  /** Whether every kind of block is in scope: `'*'`, or no target. */
  get matchesAll(): boolean {
    return this.target === undefined || this.target === '*'
  }

  /** Whether a message is a text turn this target covers. */
  matchesText(message: Message): boolean {
    if (this.matchesAll) return true
    if (this.target === 'assistantText') return message.role === 'assistant' && message.content.some(isTextContent)
    if (this.target === 'userText') return message.role === 'user' && message.content.some(isTextContent)
    return false
  }

  /** Whether a tool result is one this target covers. */
  matchesToolResult(block: ToolResultBlock, toolNameMap: Map<string, string>): boolean {
    if (this.matchesAll) return true
    if (this.target === 'toolResults') return block.status === 'success'
    if (this.target === 'toolResultErrors') return block.status === 'error'

    const toolName = toolNameMap.get(block.toolUseId)
    if (!toolName) return false
    if (this._exclude) return !this._exclude.has(toolName)
    if (this._include) return this._include.has(toolName)
    return false
  }

  /** Whether a message holds anything this target covers. */
  matchesMessage(message: Message, toolNameMap: Map<string, string>): boolean {
    if (this.matchesText(message)) return true
    if (message.role !== 'user') return false
    return message.content.some(
      (block) => block instanceof ToolResultBlock && this.matchesToolResult(block, toolNameMap)
    )
  }

  /**
   * The messages this target covers, oldest first, without the most recent ones.
   *
   * @param preserveRecent - How many matching messages to leave out of the result: an integer (1 or
   *   above) is a count, a decimal between 0 and 1 is a ratio of the matches, and 0 leaves none out.
   */
  oldestMatches(messages: Message[], preserveRecent: number, toolNameMap: Map<string, string>): Message[] {
    const matching = messages.filter((message) => this.matchesMessage(message, toolNameMap))
    if (preserveRecent <= 0) return matching
    const count = preserveRecent < 1 ? Math.ceil(matching.length * preserveRecent) : Math.floor(preserveRecent)
    return count >= matching.length ? [] : matching.slice(0, -count)
  }
}

/**
 * Parses a `string[]` target into include/exclude tool-name sets. Entries are prefixed with `tool::`
 * (e.g. `'tool::bash'`); an additional `!` prefix excludes (e.g. `'!tool::bash'`).
 */
function resolveToolFilter(target: OffloadTarget | undefined): { include?: Set<string>; exclude?: Set<string> } {
  if (!Array.isArray(target)) return {}

  const includes: string[] = []
  const excludes: string[] = []
  for (const entry of target) {
    const excluded = entry.startsWith('!')
    const name = excluded ? entry.slice(1) : entry
    const toolName = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name
    ;(excluded ? excludes : includes).push(toolName)
  }

  if (excludes.length > 0 && includes.length > 0) {
    logger.warn('tool filter contains both includes and excludes, excludes will be ignored')
    return { include: new Set(includes) }
  }
  if (excludes.length > 0) return { exclude: new Set(excludes) }
  if (includes.length > 0) return { include: new Set(includes) }
  return {}
}
