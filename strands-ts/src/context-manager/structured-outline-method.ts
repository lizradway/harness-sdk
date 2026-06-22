/**
 * {@link StructuredOutlineMethod}: a content-aware compression method that
 * replaces each oversized tool result with a *faithful structural outline* of
 * its content rather than a lossy positional/heuristic slice.
 *
 * For each message it sniffs the content type ({@link detectContentType}) and
 * dispatches to the matching outliner — code to `skeleton`, JSON to
 * `schema-only`, grep/dir/table to their structural outliners — falling back to
 * a configurable method (lean offload, by default) for unstructured content
 * that has no faithful outline. The outline tells the agent the true shape of
 * what was compressed so it can retrieve precisely on demand.
 *
 * This is the model-free, deterministic alternative to importance/positional
 * previewing: it only *routes* by content type and never decides which lines
 * matter.
 */

import { Message, TextBlock } from '../types/messages.js'
import type { CompressionMethod, MethodLike, TokenBudget } from './types.js'
import { CHARS_PER_TOKEN, messageText } from './content.js'
import { transformMessageText } from './transform.js'
import { resolveMethod, SkeletonMethod, SchemaOnlyMethod, OffloadMethod } from './methods.js'
import { detectContentType, grepOutline, treeOutline, tableOutline, type DetectedContent } from './outline.js'

/** Configuration for {@link StructuredOutlineMethod}. */
export interface StructuredOutlineConfig {
  /** Method applied to code content. Defaults to {@link SkeletonMethod}. */
  code?: MethodLike
  /** Method applied to JSON content. Defaults to {@link SchemaOnlyMethod}. */
  json?: MethodLike
  /**
   * Method applied to content with no faithful structural outline (prose, logs).
   * Defaults to {@link OffloadMethod} so the original is preserved and the agent
   * can retrieve it on demand. Set to a string shorthand to override.
   */
  fallback?: MethodLike
  /** Only outline content larger than this fraction of the window. Defaults to `0.0075`. */
  thresholdRatio?: number
  /** Absolute token threshold; overrides `thresholdRatio` when set. */
  threshold?: number
  /** Never outline the most recent N candidate messages. Defaults to `0`. */
  keepRecent?: number
}

/** Default fraction of the context window above which content is outlined. */
const DEFAULT_THRESHOLD_RATIO = 0.0075

/**
 * Content-aware structural outliner. See module docs.
 */
export class StructuredOutlineMethod implements CompressionMethod {
  readonly name = 'structured-outline'

  private readonly _thresholdRatio: number
  private readonly _threshold: number | undefined
  private readonly _keepRecent: number
  private readonly _code: CompressionMethod
  private readonly _json: CompressionMethod
  private readonly _fallback: CompressionMethod

  constructor(config?: StructuredOutlineConfig) {
    this._thresholdRatio = config?.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
    this._threshold = config?.threshold
    this._keepRecent = Math.max(0, config?.keepRecent ?? 0)
    this._code = resolveMethod(config?.code ?? new SkeletonMethod())
    this._json = resolveMethod(config?.json ?? new SchemaOnlyMethod())
    this._fallback = resolveMethod(config?.fallback ?? new OffloadMethod())
  }

  /** Inject the scratchpad into any offload-based sub-method (e.g. the fallback). */
  setScratchpad(scratchpad: import('../vended-plugins/context-offloader/storage.js').Storage): void {
    for (const m of [this._code, this._json, this._fallback]) {
      const settable = m as Partial<{ setScratchpad(s: typeof scratchpad): void }>
      settable.setScratchpad?.(scratchpad)
    }
  }

  /** Propagate the recovery hint to sub-methods that support it. */
  setRecoveryHint(hint: string): void {
    for (const m of [this._code, this._json, this._fallback]) {
      const settable = m as Partial<{ setRecoveryHint(h: string): void }>
      settable.setRecoveryHint?.(hint)
    }
  }

  /** Propagate the task/query to sub-methods that support it. */
  setQuery(query: string): void {
    for (const m of [this._code, this._json, this._fallback]) {
      const settable = m as Partial<{ setQuery(q: string): void }>
      settable.setQuery?.(query)
    }
  }

  async compress(messages: Message[], budget: TokenBudget): Promise<Message[]> {
    const thresholdTokens = this._threshold ?? Math.ceil(budget.limit * this._thresholdRatio)
    const keepFrom = messages.length - this._keepRecent
    const out: Message[] = []
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!
      const text = messageText(message)
      const tokens = Math.ceil(text.length / CHARS_PER_TOKEN)
      if (i >= keepFrom || tokens <= thresholdTokens) {
        out.push(message)
        continue
      }
      out.push(await this._outlineOne(message, text, budget))
    }
    return out
  }

  /** Outline a single oversized message by routing on its detected content type. */
  private async _outlineOne(message: Message, text: string, budget: TokenBudget): Promise<Message> {
    switch (detectContentType(text, codeHint(message))) {
      case 'grep':
        return transformMessageText(message, (t) => grepOutline(t))
      case 'tree':
        return transformMessageText(message, (t) => treeOutline(t))
      case 'table':
        return transformMessageText(message, (t) => tableOutline(t))
      case 'code':
        return single(await this._code.compress([message], budget), message)
      case 'json':
        return single(await this._json.compress([message], budget), message)
      case 'unstructured':
      default:
        return single(await this._fallback.compress([message], budget), message)
    }
  }
}

/** A method may return 0..n messages; for our 1:1 routing, take the first or keep the original. */
function single(result: Message[], original: Message): Message {
  return result[0] ?? original
}

/** Pull a file-path hint from a tool result's surrounding text for code detection. */
function codeHint(message: Message): string | undefined {
  for (const block of message.content) {
    if (block instanceof TextBlock) {
      const m = block.text.match(
        /[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|swift|kt|scala|sh|pony|ml|ex|exs)\b/i
      )
      if (m) return m[0]
    }
  }
  return undefined
}

/** Detected content categories, re-exported for callers building custom routers. */
export type { DetectedContent }
