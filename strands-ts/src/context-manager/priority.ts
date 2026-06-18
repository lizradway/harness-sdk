/**
 * Priority scoring for messages.
 *
 * Every message gets a priority; the ContextManager evicts the lowest-priority
 * messages first under budget pressure. Priority blends a role-based base score
 * with a recency bonus, treats pinned messages as never-evictable, and protects
 * messages that reference the agent's recently-accessed files (the working set).
 */

import type { Message } from '../types/messages.js'
import { isPinned } from '../conversation-manager/compression/pin-message.js'
import { hasToolUse, toolResultBlocks, isToolResultError, messageText } from './content.js'

/** Role-based base priority scores from the design. */
const BASE_USER = 100
const BASE_ASSISTANT = 80
const BASE_TOOL_USE = 60
const BASE_TOOL_RESULT = 40
const BASE_TOOL_RESULT_ERROR = 10

/** Recency contributes up to this many points to a message's priority. */
const RECENCY_WEIGHT = 30

/**
 * Bonus added to a message that references one of the recently-accessed files.
 * Set above the role spread so a tool result about the current working set
 * outranks an unrelated assistant message, keeping the working set in context
 * (the "recently accessed files" retention pattern).
 */
const RECENT_FILE_WEIGHT = 50

/** Match file-path-like tokens: a slashed path or a bare `name.ext` filename. */
const PATH_PATTERN = /(?:[\w.@-]+\/)+[\w.@-]+|\b[\w-]+\.[A-Za-z][\w]{0,8}\b/g

/**
 * Extract file-path-like references from text: slashed paths and `name.ext`
 * filenames. Returns lowercased basenames and full paths for loose matching.
 */
export function extractFilePaths(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(PATH_PATTERN)) {
    const path = m[0].toLowerCase()
    out.add(path)
    const base = path.split('/').pop()
    if (base) out.add(base)
  }
  return out
}

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
 * priority, a recency bonus that grows toward the end of the conversation, and a
 * working-set bonus when the message references one of `recentFiles`.
 *
 * @param messages - The full conversation.
 * @param recentFiles - Lowercased paths/basenames of recently-accessed files;
 *   messages mentioning any of them are protected from eviction.
 * @returns One {@link ScoredMessage} per message, in original order.
 */
export function scoreMessages(messages: Message[], recentFiles?: ReadonlySet<string>): ScoredMessage[] {
  const n = messages.length
  const hasRecent = recentFiles !== undefined && recentFiles.size > 0
  return messages.map((message, index) => {
    if (isPinned(messages, index)) {
      return { message, index, priority: Infinity }
    }
    const recency = n > 1 ? (index / (n - 1)) * RECENCY_WEIGHT : RECENCY_WEIGHT
    let priority = basePriority(message) + recency
    if (hasRecent && referencesRecentFile(message, recentFiles)) {
      priority += RECENT_FILE_WEIGHT
    }
    return { message, index, priority }
  })
}

/** Returns `true` if the message text references any of the recently-accessed files. */
function referencesRecentFile(message: Message, recentFiles: ReadonlySet<string>): boolean {
  const refs = extractFilePaths(messageText(message))
  for (const ref of refs) {
    if (recentFiles.has(ref)) return true
  }
  return false
}
