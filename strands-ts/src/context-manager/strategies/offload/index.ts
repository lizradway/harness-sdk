/**
 * Offload strategies — reduce content in the context window.
 *
 * @experimental
 */

import type { TruncateConfig } from '../../methods/truncate.js'
import type { SummarizeConfig } from '../../methods/summarize.js'
import type { ContextStrategy } from '../../types.js'
import { validateTarget } from './base.js'
import type { OffloadConditions, OffloadStrategyBuilder, OffloadTarget } from './base.js'
import { DropStrategy } from './drop.js'
import { TruncateStrategy } from './truncate.js'
import { SummarizeStrategy } from './summarize.js'

export { EmergencyTruncateStrategy } from './base.js'
export { DROPPED_MARKER } from './drop.js'
export type { OffloadTarget, OffloadConditions, OffloadStrategyBuilder, Percent } from './base.js'

/** Deliberately not a `ContextStrategy`, so `.when()` is required. */
function builder(
  target: OffloadTarget,
  when: (conditions: OffloadConditions) => ContextStrategy
): OffloadStrategyBuilder {
  validateTarget(target)
  return { when: (conditions) => when(conditions ?? {}) }
}

/**
 * Offload strategy builder namespace. Each method returns a builder; call `.when()` on it to get the strategy.
 *
 * - `Offload.drop(target)` — drop matching content from context window entirely
 * - `Offload.truncate(target, config)` — replace with a preview
 * - `Offload.summarize(target, config)` — replace with LLM-generated summary
 */
interface OffloadNamespace {
  /** Drop matching content from context window entirely. */
  drop(target: OffloadTarget): OffloadStrategyBuilder

  /** Replace oversized content with a preview. */
  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategyBuilder

  /** Replace oversized content with an LLM-generated summary. */
  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategyBuilder
}

/**
 * Builder for offload strategies — reduces content in the context window.
 *
 * Target `'*'` acts on whole messages; any other target acts on each block. `threshold` measures whichever the
 * target acts on, and `utilization` only gates when the strategy fires.
 *
 * @example
 * ```typescript
 * // Per-block: truncate each tool result over 1500 tokens to a 750-token preview, eagerly
 * Offload.truncate("toolResults", { previewTokens: 750 }).when({ threshold: 1500 })
 * // Per-block: truncate specific tools' results over 5% of the context window
 * Offload.truncate(["tool::bash", "tool::read_file"]).when({ threshold: "5%" })
 * // Messages: summarize the oldest messages at 70% utilization, keeping the newest 4
 * Offload.summarize("*").when({ utilization: "70%", preserveRecent: 4 })
 * // Per-block: drop each failed tool result over 500 tokens
 * Offload.drop("toolResultErrors").when({ threshold: 500 })
 * // Per-block, eager: with no conditions, acts on each message as it arrives
 * Offload.drop("toolResults").when({})
 * // Per-block, gated: at 80% utilization, drop older tool results, keeping the newest 5
 * Offload.drop("toolResults").when({ utilization: "80%", preserveRecent: 5 })
 * // Per-block, gated: at 80% utilization, drop older images, documents, video, and audio, keeping the newest
 * Offload.drop("media").when({ utilization: "80%", preserveRecent: 1 })
 * // Messages: once the window is full, drop the oldest messages, keeping the newest 70%
 * Offload.drop("*").when({ utilization: "100%", preserveRecent: "70%" })
 * // Messages: at 90% utilization, summarize messages over 2000 tokens, keeping the newest 4
 * Offload.summarize("*").when({ utilization: "90%", threshold: 2000, preserveRecent: 4 })
 * ```
 */
export const Offload: OffloadNamespace = {
  drop(target: OffloadTarget): OffloadStrategyBuilder {
    return builder(target, (conditions) => new DropStrategy(target, conditions))
  },

  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategyBuilder {
    return builder(target, (conditions) => new TruncateStrategy(target, config, conditions))
  },

  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategyBuilder {
    return builder(target, (conditions) => new SummarizeStrategy(target, config, conditions))
  },
}
