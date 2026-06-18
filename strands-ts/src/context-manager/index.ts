/**
 * Context management for Strands Agents.
 *
 * The {@link ContextManager} unifies compression, offloading, eviction, and
 * protection under one model: everything it does under budget pressure is a
 * {@link CompressionMethod} applied to messages. It owns priority-based candidate
 * selection, pin filtering, L1 transcript writing, and budget tracking; methods
 * only decide how to transform the candidates they receive.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { ContextManager, ContentRouter, OffloadMethod, DropMethod } from '@strands-agents/sdk/context-manager'
 *
 * const agent = new Agent({
 *   contextManager: new ContextManager({
 *     method: new ContentRouter({
 *       toolResults: new OffloadMethod({ preview: 'head-tail', keepRecent: 3 }),
 *       toolResultErrors: new DropMethod({ keepLast: 1 }),
 *       userMessages: 'protect',
 *     }),
 *   }),
 * })
 * ```
 */

export { ContextManager } from './context-manager.js'
export { ContentRouter, type ContentRoutes, type ContentCategory } from './content-router.js'
export { FallbackChain } from './fallback-chain.js'
export {
  ProtectMethod,
  SummarizeMethod,
  TruncateMethod,
  OffloadMethod,
  DropMethod,
  SkeletonMethod,
  SchemaOnlyMethod,
  CollapsePairsMethod,
  resolveMethod,
  resolveMethodShorthand,
  type SummarizeMethodConfig,
  type TruncateMethodConfig,
  type OffloadMethodConfig,
  type DropMethodConfig,
  type SkeletonMethodConfig,
  type SchemaOnlyMethodConfig,
} from './methods.js'
export { Transcript, type TranscriptReader } from './transcript.js'
export { importancePreview, queryTerms, DEFAULT_IMPORTANCE_WEIGHTS, type ImportanceWeights } from './importance.js'
export type {
  CompressionMethod,
  TokenBudget,
  MethodShorthand,
  MethodLike,
  Scratchpad,
  PreviewMode,
  TranscriptEviction,
  TranscriptConfig,
  BudgetConfig,
  ContextManagerPreset,
  ContextManagerConfig,
} from './types.js'
// Re-export the shared storage backends so context-manager users have a single import.
export { InMemoryStorage, FileStorage, S3Storage, type Storage } from '../vended-plugins/context-offloader/storage.js'
