/**
 * Priority scoring for messages.
 *
 * Every message gets a priority; the ContextManager evicts the lowest-priority
 * messages first under budget pressure. Priority blends a role-based base score
 * with a recency bonus, and treats pinned messages as never-evictable.
 */

import type { Message } from '../types/messages.js'
import { isPinned } from '../conversation-manager/compression/pin-message.js'
import { hasToolUse, toolResultBlocks, isToolResultError } from './content.js'

/** Role-based base priority scores from the design. */
const BASE_USER = 100
const BASE_ASSISTANT = 80
const BASE_TOOL_USE = 60
const BASE_TOOL_RESULT = 40
const BASE_TOOL_RESULT_ERROR = 10

/** Recency contributes up to this many points to a message's priority. */
const RECENCY_WEIGHT = 30

/**
 * Compute the base, role-derived priority for a message (before recency).
 *
 * In this SDK roles are only `user` / `assistant`, so tool-use and tool-result
 * messages are detected by inspecting their content blocks.
 */
export function basePriority(message: Message): number {
  if (isToolResultError(message)) return BASE_TOOL_RESULT_ERROR
  if (toolResultBlocks(message).length > 0) return BASE_TOOL_RESULT
  if (hasToolUse(message)) return BASE_TOOL_USE
  return message.role === 'user' ? BASE_USER : BASE_ASSISTANT
}

/** A message paired with its computed priority and original index. */
export interface ScoredMessage {
  message: Message
  index: number
  priority: number
}

/**
 * Score every message: pinned messages get `Infinity`; others get their base
 * priority plus a recency bonus that grows toward the end of the conversation.
 *
 * @param messages - The full conversation.
 * @returns One {@link ScoredMessage} per message, in original order.
 */
export function scoreMessages(messages: Message[]): ScoredMessage[] {
  const n = messages.length
  return messages.map((message, index) => {
    if (isPinned(messages, index)) {
      return { message, index, priority: Infinity }
    }
    const recency = n > 1 ? (index / (n - 1)) * RECENCY_WEIGHT : RECENCY_WEIGHT
    return { message, index, priority: basePriority(message) + recency }
  })
}
