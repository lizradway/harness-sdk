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

/**
 * Builder returned by the `Offload` namespace; deliberately not a `ContextStrategy`, so `.when()` is required.
 *
 * @internal
 */
export class OffloadBuilder implements OffloadStrategyBuilder {
  private readonly _build: (conditions: OffloadConditions) => ContextStrategy

  constructor(target: OffloadTarget, build: (conditions: OffloadConditions) => ContextStrategy) {
    validateTarget(target)
    this._build = build
  }

  when(conditions: OffloadConditions): ContextStrategy {
    return this._build(conditions)
  }
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
 * Target `'*'` without `blockThreshold` acts on whole messages; any other target, or a set `blockThreshold`,
 * acts on each block. `utilization` only gates when the strategy fires.
 *
 * @example
 * ```typescript
 * // Per-block: truncate each tool result over 1500 tokens to a 750-token preview, eagerly
 * Offload.truncate("toolResults", { previewTokens: 750 }).when({ blockThreshold: 1500 })
 * // Per-block: truncate specific tools' results over 5% of the context window
 * Offload.truncate(["tool::bash", "tool::read_file"]).when({ blockThreshold: "5%" })
 * // Messages: summarize the oldest messages at 70% utilization, keeping the newest 4
 * Offload.summarize("*").when({ utilization: "70%", preserveRecent: 4 })
 * // Per-block: drop each failed tool result over 500 tokens
 * Offload.drop("toolResultErrors").when({ blockThreshold: 500 })
 * ```
 */
export const Offload: OffloadNamespace = {
  drop(target: OffloadTarget): OffloadStrategyBuilder {
    return new OffloadBuilder(target, (conditions) => new DropStrategy(target, conditions))
  },

  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategyBuilder {
    return new OffloadBuilder(target, (conditions) => new TruncateStrategy(target, config, conditions))
  },

  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategyBuilder {
    return new OffloadBuilder(target, (conditions) => new SummarizeStrategy(target, config, conditions))
  },
}
