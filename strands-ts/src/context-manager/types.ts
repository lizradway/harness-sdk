/**
 * Core types for the {@link ContextManager}.
 *
 * The central abstraction is the {@link CompressionMethod}: everything the
 * ContextManager does under budget pressure is a method applied to messages.
 * Methods take messages in and return fewer or smaller messages out. The
 * ContextManager owns L1 writing, priority sorting, pin filtering, and budget
 * tracking — methods do not need to know about any of that.
 */

import type { Message } from '../types/messages.js'
import type { Storage } from '../vended-plugins/context-offloader/storage.js'

/**
 * A snapshot of the model's context budget at the moment a method runs.
 *
 * `target` is how many tokens the ContextManager is trying to free; methods
 * should aim to reduce the candidate messages by at least this many tokens but
 * are not required to.
 */
export interface TokenBudget {
  /** The model's context window size in tokens. */
  limit: number
  /** Current input token usage. */
  used: number
  /** Tokens still available before the limit (`limit - used`). */
  remaining: number
  /** Fraction of the window used (`used / limit`), in `[0, 1]`. */
  ratio: number
  /** How many tokens the ContextManager is trying to free this pass. */
  target: number
}

/**
 * The interface every compression method implements, including third-party ones.
 *
 * Messages in, fewer/smaller messages out. The ContextManager handles L1 writing,
 * priority sorting, pin filtering, and budget tracking — implementations only
 * decide how to transform the candidate messages.
 */
export interface CompressionMethod {
  /** A stable identifier for the method, used in logs and telemetry. */
  name: string

  /**
   * Transform the candidate messages to reduce their token footprint.
   *
   * @param messages - The candidate messages selected for compression.
   * @param budget - The current token budget snapshot.
   * @returns The transformed messages to merge back into the conversation.
   */
  compress(messages: Message[], budget: TokenBudget): Promise<Message[]>
}

/**
 * String shorthands for the built-in methods. Each resolves to a built-in
 * method instance with default configuration.
 */
export type MethodShorthand =
  | 'protect'
  | 'summarize'
  | 'truncate'
  | 'offload'
  | 'drop'
  | 'skeleton'
  | 'schema-only'
  | 'collapse-pairs'

/** A method, given either as an instance or a string shorthand. */
export type MethodLike = CompressionMethod | MethodShorthand

/**
 * Storage backend used for the L1 transcript and for offloaded content.
 *
 * This is the same {@link Storage} interface used by the context-offloader
 * plugin; the design intentionally unifies the two so backends are reusable.
 */
export type Scratchpad = Storage

/** How content is previewed when a message is offloaded or truncated. */
export type PreviewMode = 'head' | 'tail' | 'head-tail'

/** How the L1 transcript bounds its growth. */
export type TranscriptEviction = 'after-extraction' | 'oldest-first' | 'never'

/** Configuration for the L1 transcript. */
export interface TranscriptConfig {
  /** Write evicted messages to L1 before any lossy transformation. Defaults to `true`. */
  enabled?: boolean
  /** Register `get_history` / `search_history` retrieval tools. Defaults to `true`. */
  retrieval?: boolean
  /** Maximum transcript size, as a byte count or a string like `"10MB"`. */
  maxSize?: number | string
  /** Eviction policy applied when the transcript exceeds `maxSize`. */
  eviction?: TranscriptEviction
}

/** Reserved-headroom configuration for the budget. */
export interface BudgetConfig {
  /** Fraction of the window to keep free for tool results, in `[0, 1)`. */
  reserveForTools?: number
  /** Fraction of the window to keep free for memory injection, in `[0, 1)`. */
  reserveForMemory?: number
}

/** Supported preset names for the {@link ContextManager}. */
export type ContextManagerPreset = 'auto'

/**
 * Configuration for the {@link ContextManager}.
 */
export interface ContextManagerConfig {
  /**
   * Start from a named preset before applying the rest of this config.
   * Currently only `"auto"` is supported. Fields set alongside `preset`
   * override the preset's values.
   */
  preset?: ContextManagerPreset
  /** The compression method (or content router) to apply under budget pressure. */
  method?: MethodLike
  /** Storage backend for the L1 transcript and offloaded content. */
  scratchpad?: Scratchpad
  /** Context-window ratio that triggers proactive compression, in `(0, 1]`. Defaults to `0.85`. */
  threshold?: number
  /** Number of leading messages to pin (priority Infinity). Defaults to `1`. */
  protectFirst?: number
  /** L1 transcript configuration. */
  transcript?: TranscriptConfig
  /** Reserved-headroom configuration. */
  budget?: BudgetConfig
  /** Emit OpenTelemetry spans per method. Defaults to `false`. */
  telemetry?: boolean
}
