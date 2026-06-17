/**
 * L1 transcript: an append-only log of messages evicted from the context window.
 *
 * Before any lossy transformation, the {@link ContextManager} writes the original
 * messages here so the agent can recover information that was compressed away.
 * The transcript persists message JSON to a {@link Scratchpad} and keeps a
 * lightweight in-memory index for search and recency queries. It also provides
 * the `get_history` / `search_history` retrieval tools and the read interface
 * the MemoryManager consumes for L1→L2 extraction.
 */

import { Message } from '../types/messages.js'
import type { MessageData } from '../types/messages.js'
import type { Tool } from '../tools/tool.js'
import { tool } from '../tools/tool-factory.js'
import type { JSONValue } from '../types/json.js'
import { z } from 'zod'
import { logger } from '../logging/logger.js'
import type { Scratchpad, TranscriptEviction } from './types.js'
import { messageText } from './content.js'

/** One entry in the transcript index. */
interface TranscriptEntry {
  /** Storage reference for the persisted message JSON. */
  reference: string
  /** Flattened text used for search. */
  text: string
  /** Byte size of the persisted payload, used for size-based eviction. */
  size: number
  /** Original position of the message in the conversation, used to order reads. */
  position: number
  /** Monotonic insertion counter; breaks ties when positions collide. */
  seq: number
  /** Whether the MemoryManager has extracted this entry to L2. */
  extracted: boolean
}

/** Order two entries by conversation position, then by insertion order. */
function byConversationOrder(a: TranscriptEntry, b: TranscriptEntry): number {
  return a.position - b.position || a.seq - b.seq
}

/**
 * Read-only view of the transcript, suitable for handing to a MemoryManager or
 * exposing as a public API surface.
 */
export interface TranscriptReader {
  /** Return messages whose text matches the query, latest in conversation order first. */
  search(query: string, limit?: number): Promise<Message[]>
  /** Return the last N messages in conversation order. */
  getRecent(n: number): Promise<Message[]>
}

/** Parse a size that is either a number of bytes or a string like `"10MB"`. */
function parseSize(size: number | string | undefined): number | undefined {
  if (size === undefined) return undefined
  if (typeof size === 'number') return size
  const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i)
  if (!match) throw new Error(`Invalid transcript maxSize: ${size}`)
  const value = parseFloat(match[1]!)
  const unit = (match[2] ?? 'b').toLowerCase()
  const multiplier = unit === 'gb' ? 1e9 : unit === 'mb' ? 1e6 : unit === 'kb' ? 1e3 : 1
  return Math.floor(value * multiplier)
}

/**
 * Append-only transcript backed by a {@link Scratchpad}.
 */
export class Transcript implements TranscriptReader {
  private readonly _scratchpad: Scratchpad
  private readonly _maxSize: number | undefined
  private readonly _eviction: TranscriptEviction
  private readonly _entries: TranscriptEntry[] = []
  private _totalSize = 0
  private _counter = 0

  constructor(config: { scratchpad: Scratchpad; maxSize?: number | string; eviction?: TranscriptEviction }) {
    this._scratchpad = config.scratchpad
    this._maxSize = parseSize(config.maxSize)
    this._eviction = config.eviction ?? 'oldest-first'
  }

  /** Number of entries currently held in the transcript. */
  get size(): number {
    return this._entries.length
  }

  /** Total persisted byte size of all entries. */
  get byteSize(): number {
    return this._totalSize
  }

  /**
   * Append messages to the transcript, persisting each to the scratchpad.
   *
   * Entries are kept in conversation order (by `positions[i]`) so reads return
   * a faithful transcript regardless of the order messages were evicted in.
   *
   * @param messages - The original (pre-transformation) messages to preserve.
   * @param positions - Original conversation index for each message. When omitted,
   *   messages are appended after all existing entries in the given order.
   */
  async append(messages: Message[], positions?: number[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!
      const payload = new TextEncoder().encode(JSON.stringify(message.toJSON()))
      let reference: string
      try {
        reference = await this._scratchpad.store(`transcript_${++this._counter}`, payload, 'application/json')
      } catch (err) {
        logger.warn(`error=<${err}> | transcript append failed, message not preserved to L1`)
        continue
      }
      const position = positions?.[i] ?? Number.MAX_SAFE_INTEGER
      this._entries.push({
        reference,
        text: messageText(message),
        size: payload.length,
        position,
        seq: this._counter,
        extracted: false,
      })
      this._totalSize += payload.length
    }
    // Keep entries in conversation order so reads behave like a real transcript.
    this._entries.sort(byConversationOrder)
    await this._evictIfNeeded()
  }

  /** Mark the oldest `count` entries as extracted to L2 (called by a MemoryManager bridge). */
  markExtracted(count: number): void {
    for (let i = 0; i < Math.min(count, this._entries.length); i++) {
      this._entries[i]!.extracted = true
    }
  }

  async search(query: string, limit = 10): Promise<Message[]> {
    const needle = query.toLowerCase()
    const matches: TranscriptEntry[] = []
    for (let i = this._entries.length - 1; i >= 0 && matches.length < limit; i--) {
      if (this._entries[i]!.text.toLowerCase().includes(needle)) matches.push(this._entries[i]!)
    }
    return this._load(matches)
  }

  async getRecent(n: number): Promise<Message[]> {
    const slice = this._entries.slice(Math.max(0, this._entries.length - n))
    return this._load(slice)
  }

  /** Build the `get_history` / `search_history` retrieval tools. */
  retrievalTools(): Tool[] {
    const getHistory = tool({
      name: 'get_history',
      description:
        'Retrieve messages that were evicted from the context window into the session transcript (L1). ' +
        'Returns the most recent evicted messages. Use this to recover detail that was compressed away.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Maximum messages to return. Default: 10.'),
        offset: z.number().int().min(0).optional().describe('Number of most-recent messages to skip. Default: 0.'),
      }),
      callback: async (input) => {
        const limit = input.limit ?? 10
        const offset = input.offset ?? 0
        const end = this._entries.length - offset
        const start = Math.max(0, end - limit)
        const slice = this._entries.slice(start, Math.max(start, end))
        const messages = await this._load(slice)
        return messages.map((m) => m.toJSON()) as unknown as JSONValue
      },
    })

    const searchHistory = tool({
      name: 'search_history',
      description:
        'Search the session transcript (L1) of evicted messages for a keyword or phrase. ' +
        'Returns matching messages, most recent first.',
      inputSchema: z.object({
        query: z.string().describe('Keyword or phrase to search for.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum messages to return. Default: 10.'),
      }),
      callback: async (input) => {
        const messages = await this.search(input.query, input.limit ?? 10)
        return messages.map((m) => m.toJSON()) as unknown as JSONValue
      },
    })

    return [getHistory, searchHistory]
  }

  private async _load(entries: TranscriptEntry[]): Promise<Message[]> {
    const out: Message[] = []
    for (const entry of entries) {
      try {
        const { content } = await this._scratchpad.retrieve(entry.reference)
        const data = JSON.parse(new TextDecoder().decode(content)) as MessageData
        out.push(Message.fromMessageData(data))
      } catch (err) {
        logger.warn(`reference=<${entry.reference}>, error=<${err}> | transcript entry could not be loaded`)
      }
    }
    return out
  }

  private async _evictIfNeeded(): Promise<void> {
    if (this._maxSize === undefined || this._eviction === 'never') return
    while (this._totalSize > this._maxSize && this._entries.length > 0) {
      // For "after-extraction", only evict entries the MemoryManager has processed.
      if (this._eviction === 'after-extraction' && !this._entries[0]!.extracted) break
      const removed = this._entries.shift()!
      this._totalSize -= removed.size
    }
  }
}
