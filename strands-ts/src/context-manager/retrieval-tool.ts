/**
 * Retrieval tool for accessing stashed (L1) content.
 *
 * Registered automatically when the ContextManager has storage configured.
 *
 * @internal
 */

import { z } from 'zod'
import { tool } from '../tools/tool-factory.js'
import { searchContent } from '../vended-plugins/context-offloader/search.js'
import { DocumentBlock, ImageBlock, VideoBlock } from '../types/media.js'
import { CitationsBlock } from '../types/citations.js'
import {
  contentBlockFromData,
  JsonBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  toolResultContentFromData,
} from '../types/messages.js'
import type {
  ContentBlock,
  ContentBlockData,
  MessageData,
  ToolResultContent,
  ToolResultContentData,
} from '../types/messages.js'
import type { JSONValue } from '../types/json.js'
import type { Tool } from '../tools/tool.js'
import { parseStashKey, type Stash } from './stash.js'

/** What a stash entry holds: one stored block, or the messages removed together. */
type StashEntry = ToolResultContent | ContentBlock | Message[]

export const RETRIEVAL_TOOL_NAME = 'retrieve_context'

const DEFAULT_MAX_RESULT_TOKENS = 10_000
const CHARS_PER_TOKEN = 4

const retrievalInputSchema = z.object({
  reference: z.string().describe('The reference key from the offload placeholder.'),
  pattern: z.string().optional().describe('Regex or keyword to grep for. Returns matching lines with context.'),
  line_range: z
    .object({
      start: z.number().int().min(1).describe('First line to return (1-indexed).'),
      end: z.number().int().min(1).describe('Last line to return (1-indexed).'),
    })
    .optional()
    .describe('Return only this span of lines.'),
  context_lines: z.number().int().min(0).optional().describe('Lines of context around each match (default: 5).'),
})

/**
 * Creates the retrieval tool for the given stash.
 *
 * @param stash - The stash instance to retrieve from
 * @param maxResultTokens - Maximum tokens in the retrieval result
 * @returns A Tool that can retrieve stashed content
 *
 * @internal
 */
export function createRetrievalTool(stash: Stash, maxResultTokens?: number): Tool {
  const maxChars = (maxResultTokens ?? DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN

  return tool({
    name: RETRIEVAL_TOOL_NAME,
    description:
      'Retrieve content that was offloaded from context.\n\n' +
      'When content is offloaded (truncated, dropped, or summarized), the original is ' +
      'persisted and a reference key is left in its place. Use this tool with that ' +
      'reference to access the original content.\n\n' +
      'Options:\n' +
      '  - pattern: regex/keyword to find matching lines with context\n' +
      '  - line_range: { start, end } to read a specific span\n' +
      '  - Without pattern/line_range: returns the full original content\n\n' +
      'Examples:\n' +
      '  { reference: "toolu_abc", pattern: "error" }\n' +
      '  { reference: "toolu_abc", line_range: { start: 10, end: 25 } }\n' +
      '  { reference: "toolu_abc" }',
    inputSchema: retrievalInputSchema,
    callback: async (input) => {
      const entries = await resolveReference(stash, input.reference)
      if (entries.length === 0) return `Error: reference not found: ${input.reference}`
      if (!input.pattern && !input.line_range) return fullContent(entries, maxChars)
      return searchEntries(entries, input, maxChars)
    },
  })
}

/**
 * The stored content itself. Tool result items are returned as the blocks they are, so media reaches
 * the model as media and only their text is cut to `maxChars`; anything else is returned in its JSON form.
 */
function fullContent(entries: StashEntry[], maxChars: number): JSONValue {
  if (entries.every(isToolResultContent)) {
    const blocks = clipText(entries, maxChars)
    return (blocks.length === 1 ? blocks[0]! : blocks) as unknown as JSONValue
  }
  const data = entries.length === 1 ? entryToData(entries[0]!) : entries.map(entryToData)
  const serialized = JSON.stringify(data)
  return serialized.length <= maxChars ? data : `${serialized.slice(0, maxChars)}\n\n[truncated]`
}

function isToolResultContent(entry: StashEntry): entry is ToolResultContent {
  return (
    entry instanceof TextBlock ||
    entry instanceof JsonBlock ||
    entry instanceof ImageBlock ||
    entry instanceof VideoBlock ||
    entry instanceof DocumentBlock
  )
}

/** Cuts the items' text to `maxChars` in total, in order; media passes through untouched. */
function clipText(blocks: ToolResultContent[], maxChars: number): ToolResultContent[] {
  let budget = maxChars
  return blocks.map((block) => {
    const text = blockText(block)
    if (text === null) return block
    if (text.length <= budget) {
      budget -= text.length
      return block
    }
    const clipped = new TextBlock(`${text.slice(0, budget)}\n\n[truncated]`)
    budget = 0
    return clipped
  })
}

/** The lines of the entries' text that match `pattern` or fall in `line_range`. */
function searchEntries(
  entries: StashEntry[],
  input: z.infer<typeof retrievalInputSchema>,
  maxChars: number
): ReturnType<typeof searchContent> {
  const text = joinText(entries.map(entryText))
  if (!text) return 'Error: cannot search non-text content. Omit pattern/line_range to retrieve full content.'
  return searchContent(
    text,
    { pattern: input.pattern, line_range: input.line_range, context_lines: input.context_lines ?? 5 },
    maxChars
  )
}

/**
 * Resolves a reference to its stored entries. An exact key resolves to one entry; an id (a tool
 * result's `toolUseId`, or `removed-<trackingId>`) resolves to every entry keyed under it, in index order.
 */
async function resolveReference(stash: Stash, reference: string): Promise<StashEntry[]> {
  const exact = await stash.retrieve(reference)
  if (exact) return entriesFrom([exact])

  const keys = (await stash.list(`${reference}_`))
    .map((key) => ({ key, parsed: parseStashKey(key) }))
    .filter(({ parsed }) => parsed?.id === reference)
    .sort((left, right) => left.parsed!.index - right.parsed!.index)
    .map(({ key }) => key)
  return entriesFrom(await Promise.all(keys.map((key) => stash.retrieve(key))))
}

function entriesFrom(results: ReadonlyArray<{ data: unknown } | null>): StashEntry[] {
  return results.flatMap((result) => {
    const entry = result && stashEntryFromData(result.data)
    return entry ? [entry] : []
  })
}

/** Deserializes a stash entry with the same readers that load it from a session. */
function stashEntryFromData(data: unknown): StashEntry | null {
  if (Array.isArray(data)) return data.map((message) => Message.fromMessageData(message as MessageData))
  if (data === null || typeof data !== 'object') return null
  try {
    return toolResultContentFromData(data as ToolResultContentData)
  } catch {
    try {
      return contentBlockFromData(data as ContentBlockData)
    } catch {
      return null
    }
  }
}

function entryToData(entry: StashEntry): JSONValue {
  const data = Array.isArray(entry) ? entry.map((message) => message.toJSON()) : entry.toJSON()
  return data as unknown as JSONValue
}

/** The searchable text of an entry: its text, JSON, and tool-result text, in order. */
function entryText(entry: StashEntry): string | null {
  if (Array.isArray(entry)) return joinText(entry.flatMap((message) => message.content.map(blockText)))
  return blockText(entry)
}

function blockText(block: ContentBlock | ToolResultContent): string | null {
  if (block instanceof TextBlock) return block.text
  if (block instanceof JsonBlock) return JSON.stringify(block.json, null, 2)
  if (block instanceof ToolResultBlock) return joinText(block.content.map(blockText))
  if (block instanceof CitationsBlock) return joinText(block.content.map((cited) => cited.text ?? null))
  return null
}

function joinText(parts: ReadonlyArray<string | null>): string | null {
  const present = parts.filter((part): part is string => part !== null)
  return present.length > 0 ? present.join('\n') : null
}
