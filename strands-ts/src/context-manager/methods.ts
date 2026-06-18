/**
 * Built-in {@link CompressionMethod} implementations.
 *
 * Each method takes the candidate messages the ContextManager selected for
 * compression and returns transformed messages. Methods never write to L1 or
 * inspect priorities — the ContextManager owns that. They only decide how to
 * shrink or drop the messages handed to them.
 */

import { Message, TextBlock } from '../types/messages.js'
import type { Model } from '../models/model.js'
import {
  generateSummary,
  DEFAULT_SUMMARIZATION_PROMPT,
} from '../conversation-manager/compression/context-compression.js'
import type { Storage } from '../vended-plugins/context-offloader/storage.js'
import { logger } from '../logging/logger.js'
import type { CompressionMethod, MethodLike, MethodShorthand, PreviewMode, TokenBudget } from './types.js'
import { CHARS_PER_TOKEN, messageText, previewText } from './content.js'
import { transformMessageText } from './transform.js'

/** Default tokens kept as an inline preview when offloading or truncating. */
const DEFAULT_PREVIEW_TOKENS = 750
/** Default fraction of the context window above which a tool result is offloaded. */
const DEFAULT_OFFLOAD_THRESHOLD_RATIO = 0.0075

/**
 * Standard hint appended to lossily-compressed content so the model knows the
 * full original is recoverable from the L1 transcript. The ContextManager
 * injects this only when the retrieval tools are actually registered.
 */
export const DEFAULT_RECOVERY_HINT =
  'The full original was preserved — recover it with search_history(query) or get_history().'

/**
 * Append a recovery hint to the last top-level text block of each message.
 *
 * Messages without a top-level text block (e.g. a tool-result message, where
 * the text lives inside the result) are left unchanged to avoid producing
 * structurally invalid content. A no-op when `hint` is empty.
 */
function appendRecoveryHint(messages: Message[], hint: string): Message[] {
  if (!hint) return messages
  return messages.map((message) => {
    let lastTextIndex = -1
    for (let i = message.content.length - 1; i >= 0; i--) {
      if (message.content[i] instanceof TextBlock) {
        lastTextIndex = i
        break
      }
    }
    if (lastTextIndex === -1) return message
    const content = message.content.map((block, i) =>
      i === lastTextIndex ? new TextBlock(`${(block as TextBlock).text}\n\n[${hint}]`) : block
    )
    return new Message({
      role: message.role,
      content,
      ...(message.metadata !== undefined && { metadata: message.metadata }),
    })
  })
}

/**
 * Keep messages unchanged. Used for content that must never be compressed
 * (e.g. user messages). The ContextManager skips L1 writes for protected
 * content because it stays in L0.
 */
export class ProtectMethod implements CompressionMethod {
  readonly name = 'protect'

  async compress(messages: Message[], _budget?: TokenBudget): Promise<Message[]> {
    return messages
  }
}

/** Configuration for {@link SummarizeMethod}. */
export interface SummarizeMethodConfig {
  /** Target fraction of the original size to summarize down to. Informational; defaults to `0.3`. */
  ratio?: number
  /** Model used to generate summaries. Falls back to the agent's model. */
  model?: Model
  /** Custom summarization system prompt. */
  prompt?: string
}

/**
 * Replace candidate messages with a single model-generated summary message.
 */
export class SummarizeMethod implements CompressionMethod {
  readonly name = 'summarize'

  private readonly _ratio: number
  private _model: Model | undefined
  private readonly _prompt: string
  private _recoveryHint = ''

  constructor(config?: SummarizeMethodConfig) {
    this._ratio = Math.max(0.1, Math.min(0.8, config?.ratio ?? 0.3))
    this._model = config?.model
    this._prompt = config?.prompt ?? DEFAULT_SUMMARIZATION_PROMPT
  }

  /** The configured target ratio, exposed for the ContextManager and tests. */
  get ratio(): number {
    return this._ratio
  }

  /** The model override, if any. The ContextManager supplies its own model when unset. */
  get model(): Model | undefined {
    return this._model
  }

  /** Inject a model when none was configured. The ContextManager calls this with the agent model. */
  setModel(model: Model): void {
    if (!this._model) this._model = model
  }

  /** Set the recovery hint appended to output. The ContextManager calls this when L1 retrieval is on. */
  setRecoveryHint(hint: string): void {
    this._recoveryHint = hint
  }

  async compress(messages: Message[], _budget?: TokenBudget): Promise<Message[]> {
    if (messages.length === 0) return messages
    if (!this._model) {
      throw new Error('SummarizeMethod requires a model — none was provided and no agent model was attached')
    }
    const summary = await generateSummary(messages, this._model, this._prompt)
    return appendRecoveryHint([summary], this._recoveryHint)
  }
}

/** Configuration for {@link TruncateMethod}. */
export interface TruncateMethodConfig {
  /** Which part of the content to keep. Defaults to `head-tail`. */
  keep?: PreviewMode
  /** Tokens of content to keep. Defaults to `750`. */
  tokens?: number
  /** Never truncate the most recent N candidate messages. Defaults to `0`. */
  keepRecent?: number
}

/**
 * Replace each candidate message's text with a head / tail / head-tail slice.
 * The most recent `keepRecent` messages are left verbatim.
 */
export class TruncateMethod implements CompressionMethod {
  readonly name = 'truncate'

  private readonly _keep: PreviewMode
  private readonly _tokens: number
  private readonly _keepRecent: number
  private _recoveryHint = ''
  private _query: string | undefined

  constructor(config?: TruncateMethodConfig) {
    this._keep = config?.keep ?? 'head-tail'
    this._tokens = config?.tokens ?? DEFAULT_PREVIEW_TOKENS
    this._keepRecent = Math.max(0, config?.keepRecent ?? 0)
  }

  /** Set the recovery hint appended to output. The ContextManager calls this when L1 retrieval is on. */
  setRecoveryHint(hint: string): void {
    this._recoveryHint = hint
  }

  /** Set the task/query text used by the `importance` preview mode. */
  setQuery(query: string): void {
    this._query = query
  }

  async compress(messages: Message[], _budget?: TokenBudget): Promise<Message[]> {
    const keepFrom = messages.length - this._keepRecent
    const truncated = messages.map((m, i) =>
      i >= keepFrom ? m : transformMessageText(m, (text) => previewText(text, this._keep, this._tokens, this._query))
    )
    return appendRecoveryHint(truncated, this._recoveryHint)
  }
}

/** Configuration for {@link OffloadMethod}. */
export interface OffloadMethodConfig {
  /** Which part of the content to keep inline as a preview. Defaults to `head-tail`. */
  preview?: PreviewMode
  /** Tokens of preview to keep inline. Defaults to `750`. */
  previewTokens?: number
  /** Offload content larger than this fraction of the context window. Defaults to `0.0075`. */
  thresholdRatio?: number
  /** Absolute token threshold; overrides `thresholdRatio` when set. */
  threshold?: number
  /** Never offload the most recent N candidate messages. Defaults to `0`. */
  keepRecent?: number
  /** Storage backend; supplied by the ContextManager when omitted. */
  scratchpad?: Storage
  /** Method (or shorthand) applied to content below the offload threshold. */
  fallback?: MethodLike
}

/**
 * Replace large candidate messages with an inline preview plus a storage
 * reference, persisting the original content to the scratchpad. Smaller
 * messages are routed to the fallback method (truncate by default).
 */
export class OffloadMethod implements CompressionMethod {
  readonly name = 'offload'

  private readonly _preview: PreviewMode
  private readonly _previewTokens: number
  private readonly _thresholdRatio: number
  private readonly _threshold: number | undefined
  private readonly _keepRecent: number
  private _scratchpad: Storage | undefined
  private readonly _fallback: MethodLike
  private _fallbackMethod: CompressionMethod | undefined
  private _recoveryHint = ''
  private _query: string | undefined

  constructor(config?: OffloadMethodConfig) {
    this._preview = config?.preview ?? 'head-tail'
    this._previewTokens = config?.previewTokens ?? DEFAULT_PREVIEW_TOKENS
    this._thresholdRatio = config?.thresholdRatio ?? DEFAULT_OFFLOAD_THRESHOLD_RATIO
    this._threshold = config?.threshold
    this._keepRecent = Math.max(0, config?.keepRecent ?? 0)
    this._scratchpad = config?.scratchpad
    this._fallback = config?.fallback ?? 'truncate'
  }

  /** The fallback method spec, resolved lazily by the ContextManager. */
  get fallback(): MethodLike {
    return this._fallback
  }

  /** Inject the scratchpad backend when the ContextManager owns it. */
  setScratchpad(scratchpad: Storage): void {
    if (!this._scratchpad) this._scratchpad = scratchpad
  }

  /** Set the recovery hint appended to output. The ContextManager calls this when L1 retrieval is on. */
  setRecoveryHint(hint: string): void {
    this._recoveryHint = hint
  }

  /** Set the task/query text used by the `importance` preview mode (also propagated to the fallback). */
  setQuery(query: string): void {
    this._query = query
  }

  async compress(messages: Message[], budget: TokenBudget): Promise<Message[]> {
    const thresholdTokens = this._threshold ?? Math.ceil(budget.limit * this._thresholdRatio)
    const keepFrom = messages.length - this._keepRecent
    const out: Message[] = []
    const belowThreshold: Array<{ index: number; message: Message }> = []
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!
      // Recent messages are kept verbatim and are never candidates for the fallback.
      if (i >= keepFrom) {
        out.push(message)
        continue
      }
      const text = messageText(message)
      const tokens = Math.ceil(text.length / CHARS_PER_TOKEN)
      if (tokens > thresholdTokens) {
        out.push(await this._offloadOne(message, text, tokens))
      } else {
        // Defer below-threshold messages to the fallback method (e.g. truncate).
        belowThreshold.push({ index: i, message })
        out.push(message)
      }
    }
    if (belowThreshold.length > 0) {
      const compressed = await this._fallbackOf().compress(
        belowThreshold.map((b) => b.message),
        budget
      )
      // Replace deferred messages in place. The fallback is 1:1 (truncate/skeleton);
      // if it ever changes the count, fall back to appending its output.
      if (compressed.length === belowThreshold.length) {
        belowThreshold.forEach((b, i) => {
          out[b.index] = compressed[i]!
        })
      } else {
        for (const b of belowThreshold) out.splice(out.indexOf(b.message), 1)
        out.push(...compressed)
      }
    }
    return out
  }

  /** Resolve and memoize the fallback method, propagating the recovery hint and query. */
  private _fallbackOf(): CompressionMethod {
    if (!this._fallbackMethod) {
      this._fallbackMethod = resolveMethod(this._fallback)
      const settable = this._fallbackMethod as Partial<{
        setRecoveryHint(hint: string): void
        setQuery(query: string): void
      }>
      if (this._recoveryHint && typeof settable.setRecoveryHint === 'function') {
        settable.setRecoveryHint(this._recoveryHint)
      }
      if (this._query && typeof settable.setQuery === 'function') {
        settable.setQuery(this._query)
      }
    }
    return this._fallbackMethod
  }

  private async _offloadOne(message: Message, text: string, tokens: number): Promise<Message> {
    if (!this._scratchpad) {
      // No backend to persist to — degrade to a preview-only truncation.
      return transformMessageText(message, (t) => previewText(t, this._preview, this._previewTokens, this._query))
    }
    let reference: string
    try {
      reference = await this._scratchpad.store(`offload_${message.role}`, new TextEncoder().encode(text), 'text/plain')
    } catch (err) {
      logger.warn(`error=<${err}> | offload store failed, falling back to preview`)
      return transformMessageText(message, (t) => previewText(t, this._preview, this._previewTokens, this._query))
    }
    const preview = previewText(text, this._preview, this._previewTokens, this._query)
    const recovery = this._recoveryHint
      ? ` ${this._recoveryHint}`
      : ' The full original was preserved in the session transcript.'
    const placeholder = `[Offloaded ~${tokens.toLocaleString()} tokens (ref: ${reference}).${recovery}]\n\n${preview}`
    return transformMessageText(message, () => placeholder)
  }
}

/** Configuration for {@link DropMethod}. */
export interface DropMethodConfig {
  /** Keep the most recent N candidates and drop the rest. Defaults to `0` (drop all). */
  keepLast?: number
}

/**
 * Remove candidate messages entirely. The ContextManager does not write dropped
 * messages to L1 — they are discarded without preservation.
 */
export class DropMethod implements CompressionMethod {
  readonly name = 'drop'

  private readonly _keepLast: number

  constructor(config?: DropMethodConfig) {
    this._keepLast = Math.max(0, config?.keepLast ?? 0)
  }

  async compress(messages: Message[], _budget?: TokenBudget): Promise<Message[]> {
    if (this._keepLast === 0) return []
    return messages.slice(messages.length - this._keepLast)
  }
}

/** Configuration for {@link SkeletonMethod}. */
export interface SkeletonMethodConfig {
  /** Languages to apply skeletonization to. Informational; defaults to a common set. */
  languages?: string[]
  /** Method (or shorthand) applied when skeletonization cannot reduce content. */
  fallback?: MethodLike
}

/**
 * Reduce code blocks to their signatures, dropping function/method bodies.
 *
 * Uses a brace-depth heuristic: lines at the top two nesting levels (signatures,
 * declarations, and the lines that open blocks) are kept; deeper lines (bodies)
 * are elided. Language-agnostic and dependency-free.
 */
export class SkeletonMethod implements CompressionMethod {
  readonly name = 'skeleton'

  private readonly _fallback: MethodLike
  private _recoveryHint = ''

  constructor(config?: SkeletonMethodConfig) {
    this._fallback = config?.fallback ?? 'truncate'
  }

  /** The fallback method spec, resolved lazily by the ContextManager. */
  get fallback(): MethodLike {
    return this._fallback
  }

  /** Set the recovery hint appended to output. The ContextManager calls this when L1 retrieval is on. */
  setRecoveryHint(hint: string): void {
    this._recoveryHint = hint
  }

  async compress(messages: Message[], _budget?: TokenBudget): Promise<Message[]> {
    const skeletons = messages.map((m) => transformMessageText(m, (text) => skeletonize(text)))
    return appendRecoveryHint(skeletons, this._recoveryHint)
  }
}

/**
 * Keep code structure (signatures, the lines that open blocks) and drop bodies.
 */
function skeletonize(code: string): string {
  const lines = code.split('\n')
  const out: string[] = []
  let depth = 0
  for (const line of lines) {
    const opens = (line.match(/[{([]/g) ?? []).length
    const closes = (line.match(/[})\]]/g) ?? []).length
    const startDepth = depth
    depth = Math.max(0, depth + opens - closes)
    // Keep lines at the top level (signatures and declarations, which open a
    // block) and the lines that close a block back to the top level. Elide the
    // deeper body lines in between.
    if (startDepth === 0 || depth === 0) {
      out.push(line)
    } else if (out[out.length - 1] !== '    // ...') {
      out.push('    // ...')
    }
  }
  return out.join('\n')
}

/** Configuration for {@link SchemaOnlyMethod}. */
export interface SchemaOnlyMethodConfig {
  /** Method (or shorthand) applied when content is not parseable JSON. */
  fallback?: MethodLike
}

/**
 * Reduce JSON content to its structure: object keys and array shape are kept,
 * scalar values are replaced with their type names. Falls back for non-JSON.
 */
export class SchemaOnlyMethod implements CompressionMethod {
  readonly name = 'schema-only'

  private readonly _fallback: MethodLike
  private _recoveryHint = ''

  constructor(config?: SchemaOnlyMethodConfig) {
    this._fallback = config?.fallback ?? 'truncate'
  }

  /** The fallback method spec, resolved lazily by the ContextManager. */
  get fallback(): MethodLike {
    return this._fallback
  }

  /** Set the recovery hint appended to output. The ContextManager calls this when L1 retrieval is on. */
  setRecoveryHint(hint: string): void {
    this._recoveryHint = hint
  }

  async compress(messages: Message[], _budget?: TokenBudget): Promise<Message[]> {
    const schematized = messages.map((m) =>
      transformMessageText(m, (text) => {
        try {
          const parsed: unknown = JSON.parse(text)
          return JSON.stringify(schematize(parsed), null, 2)
        } catch {
          return text
        }
      })
    )
    return appendRecoveryHint(schematized, this._recoveryHint)
  }
}

/** Replace scalar values with their type names while preserving keys and shape. */
function schematize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [schematize(value[0])]
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] = schematize(v)
    }
    return out
  }
  if (value === null) return 'null'
  return typeof value
}

/**
 * Collapse a candidate run into a single one-line summary message per message,
 * folding tool_use/tool_result pairs into a compact textual note.
 */
export class CollapsePairsMethod implements CompressionMethod {
  readonly name = 'collapse-pairs'

  private _recoveryHint = ''

  /** Set the recovery hint appended to output. The ContextManager calls this when L1 retrieval is on. */
  setRecoveryHint(hint: string): void {
    this._recoveryHint = hint
  }

  async compress(messages: Message[], _budget?: TokenBudget): Promise<Message[]> {
    const collapsed = messages.map((m) => {
      const summary = messageText(m)
      const oneLine = summary.replace(/\s+/g, ' ').slice(0, CHARS_PER_TOKEN * 60)
      return new Message({
        role: m.role,
        content: [new TextBlock(`[collapsed ${m.role} turn] ${oneLine}`)],
        ...(m.metadata !== undefined && { metadata: m.metadata }),
      })
    })
    return appendRecoveryHint(collapsed, this._recoveryHint)
  }
}

/** Map a string shorthand to a freshly constructed built-in method. */
export function resolveMethodShorthand(shorthand: MethodShorthand): CompressionMethod {
  switch (shorthand) {
    case 'protect':
      return new ProtectMethod()
    case 'summarize':
      return new SummarizeMethod()
    case 'truncate':
      return new TruncateMethod()
    case 'offload':
      return new OffloadMethod()
    case 'drop':
      return new DropMethod()
    case 'skeleton':
      return new SkeletonMethod()
    case 'schema-only':
      return new SchemaOnlyMethod()
    case 'collapse-pairs':
      return new CollapsePairsMethod()
    default: {
      const exhaustive: never = shorthand
      throw new Error(`Unknown method shorthand: ${String(exhaustive)}`)
    }
  }
}

/** Resolve a method-or-shorthand into a concrete {@link CompressionMethod}. */
export function resolveMethod(method: MethodLike): CompressionMethod {
  return typeof method === 'string' ? resolveMethodShorthand(method) : method
}
