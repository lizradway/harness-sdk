# ContextManager API & Developer Experience

## Overview

The ContextManager is a first-class agent parameter that handles context reduction through an ordered strategy pipeline. It has two layers:

- **L0 (context window)**: The agent's active message array. Strategies mutate this in place.
- **L1 (stash)**: Durable storage where originals are persisted before replacement. The agent retrieves stashed content on demand via a tool.

## Quick Start

```typescript
import { Agent, ContextManager, Offload } from '@strands-agents/sdk'

// Zero config — uses default pipeline
const agent = new Agent({
  model,
  contextManager: new ContextManager(),
})

// Custom strategies
const agent = new Agent({
  model,
  contextManager: new ContextManager({
    strategies: [
      Offload.truncate('toolResults', { previewTokens: 750 }).when({ threshold: 1500 }),
      Offload.summarize('toolResults').when({ utilization: 0.85, preserveRecent: 4 }),
      Offload('toolResultErrors').when({ threshold: 500 }),
    ],
  }),
})

// Disable all context management
const agent = new Agent({ model, contextManager: false })
```

## API Shapes

### ContextManager

```typescript
interface ContextManagerConfig {
  strategies?: ContextStrategy[]  // Ordered pipeline. Defaults provided if omitted.
  storage?: Storage               // L1 backend. Defaults to InMemoryStorage.
}

class ContextManager implements Plugin {
  constructor(config?: ContextManagerConfig)
  initAgent(agent: LocalAgent): void   // Called automatically by Agent
  apply(): Promise<void>               // Manually trigger the pipeline
  getTools(): Tool[]                   // Returns [retrieve_context] tool
}
```

### Offload Builder

Three methods, three reduction styles:

```typescript
// Drop — replace content with "[Dropped]"
Offload(target?: OffloadTarget): OffloadStrategyBuilder
Offload('toolResults')
Offload('toolResultErrors')
Offload('assistantMessages')
Offload('userMessages')
Offload(['bash', 'read_file'])     // by tool name
Offload(['!search'])               // exclude specific tools
Offload()                          // everything

// Truncate — replace with head/tail preview
Offload.truncate(target?, config?: TruncateConfig): OffloadStrategyBuilder
Offload.truncate('toolResults', { previewTokens: 750 })
Offload.truncate({ previewTokens: 500 })  // config-only, targets everything

// Summarize — replace with LLM-generated summary (multimodal-aware)
Offload.summarize(target?, config?: SummarizeConfig): OffloadStrategyBuilder
Offload.summarize('toolResults', { model: cheapModel })
Offload.summarize({ systemPrompt: 'Be very terse.' })
```

All return `OffloadStrategyBuilder`, which is both a `ContextStrategy` and chainable:

```typescript
interface OffloadStrategyBuilder extends ContextStrategy {
  when(conditions: OffloadConditions): ContextStrategy
}
```

### Conditions

```typescript
interface OffloadConditions {
  threshold?: number       // Token count above which individual blocks are acted on
  utilization?: number     // Context window ratio (0-1+) above which the strategy fires
  preserveRecent?: number  // Leave the N most recent matching messages untouched
}
```

**Conditions determine execution granularity:**

| `threshold` | `utilization` | Behavior |
|---|---|---|
| set | — | Per-block, eagerly on arrival |
| — | set | Message-level batch (sliding window / batched summary) |
| set | set | Per-block, gated by utilization |

**`utilization`** gates whether the strategy runs at all.
**`threshold`** filters which individual blocks to act on.

### Targets

```typescript
type OffloadTarget =
  | 'toolResults'        // Successful tool results
  | 'toolResultErrors'   // Failed tool results
  | 'assistantMessages'  // Text in assistant messages
  | 'userMessages'       // Text in user messages (not tool results)
  | string[]             // Tool results from specific tools (prefix ! to exclude)
  // undefined = everything
```

### TruncateConfig

```typescript
interface TruncateConfig {
  previewTokens?: number   // Size budget for the preview (default: 1000)
  preview?: 'head' | 'tail' | 'headTail'  // Which end(s) to keep (default: 'headTail')
}
```

### SummarizeConfig

```typescript
interface SummarizeConfig {
  model?: Model         // Model for summarization (default: agent's model)
  systemPrompt?: string // Custom system prompt
}
```

### ContextStrategy (extension point)

```typescript
interface ContextStrategy {
  readonly name: string
  init?(agent: LocalAgent, stash: Stash): void
  apply(context: ContextState): Promise<boolean>
}

interface ContextState {
  messages: Message[]       // L0 — mutate in place
  agent: LocalAgent
  utilization: number       // 0-1+, above 1 = overflow
  stash: Stash             // L1 storage
}
```

## Stash (L1)

The stash persists originals before they're replaced in L0. The agent gets a `retrieve_context` tool to access them on demand.

### Storage Interface

```typescript
interface Storage {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}
```

Built-in implementations:

| Backend | Constructor | Where content lands |
|---|---|---|
| `InMemoryStorage` (default) | `new InMemoryStorage()` | In-process Map (lost on restart) |
| `LocalFileStorage` | `new LocalFileStorage({ rootPath? })` | `{rootPath}/context/{key}` (default: `.agent-data/context/`) |
| `S3Storage` | `new S3Storage({ bucket, prefix? })` | `s3://{bucket}/{prefix}context/{key}` |

The Stash writes under the `context/` prefix. Keys are `{counter}_{toolUseId}_{blockIndex}`.

Example file tree with `LocalFileStorage`:
```
.agent-data/
└── context/
    ├── 1_toolu_abc123_0    # first offloaded block
    ├── 2_toolu_def456_0    # second offloaded block
    └── 3_toolu_ghi789_1    # second block within a multi-block result
```

Bring your own `Storage` implementation for other backends (DynamoDB, Redis, etc.).

### Stash API (internal, used by strategies)

```typescript
class Stash {
  constructor(storage: Storage)
  store(toolUseId: string, blockIndex: number, content: Uint8Array, contentType: string): Promise<string>
  retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string } | null>
  list(): Promise<string[]>
  delete(reference: string): Promise<void>
}
```

Stash wraps the `Storage` interface — it calls `storage.put('context/{key}', ...)` internally. The key format and `context/` prefix are managed by the Stash; consumers just pass a `Storage` instance.

### Retrieval Tool

Automatically registered. The model calls it when it needs stashed content:

```typescript
// Tool: retrieve_context
{
  reference: string              // Key from the offload marker
  pattern?: string               // Regex/keyword grep
  line_range?: { start, end }    // Line span (1-indexed)
  context_lines?: number         // Lines around each match (default: 5)
}
```

## Pipeline Behavior

Strategies run as an ordered pipeline. Each sees the output of the previous.

```typescript
strategies: [
  Offload.truncate('toolResults').when({ threshold: 2500 }),  // Runs first
  Offload.summarize('toolResults').when({ threshold: 5000 }), // Sees truncated blocks
]
```

**Order = priority.** If truncate shrinks a 10K block to ~1K, summarize's 5K threshold won't fire on it. No conflict, no special dedup logic needed.

### Execution Timing

- **BeforeModelCallEvent**: proactive — strategies run before each model call (gated by their own utilization)
- **AfterModelCallEvent (overflow)**: reactive — on ContextWindowOverflowError, strategies run + unconditional truncation as safety net, up to 3 retries
- **MessageAddedEvent (eager)**: per-block strategies with threshold and no preserveRecent fire on arrival

### Default Pipeline

```typescript
[
  Offload.truncate('toolResults').when({ threshold: 2500 }),
  Offload.summarize('toolResults').when({ threshold: 2500, utilization: 0.85 }),
]
```

## DevX Patterns

### Progressive Compression

```typescript
// Cheap first, expensive as needed
strategies: [
  Offload.truncate('toolResults', { previewTokens: 750 }).when({ threshold: 1500 }),
  Offload.summarize('toolResults').when({ utilization: 0.85, preserveRecent: 4 }),
  Offload('toolResults').when({ utilization: 0.95, preserveRecent: 2 }),
]
```

### Tool-Specific Policies

```typescript
strategies: [
  // Bash output is huge, truncate aggressively
  Offload.truncate(['bash'], { previewTokens: 500 }).when({ threshold: 1000 }),
  // File reads can be summarized
  Offload.summarize(['read_file']).when({ threshold: 3000 }),
  // Search results — just drop old ones
  Offload(['web_search']).when({ threshold: 500 }),
]
```

### Message-Level Sliding Window

```typescript
// Remove oldest tool result messages when 90% full (keep last 4)
Offload.truncate('toolResults').when({ utilization: 0.9, preserveRecent: 4 })
```

### Batched Summarization on Overflow

```typescript
// Summarize oldest messages into one when context overflows
Offload.summarize().when({ utilization: 1.0, preserveRecent: 6 })
```

### Custom Strategy

```typescript
const myStrategy: ContextStrategy = {
  name: 'my:custom-strategy',
  apply: async (ctx) => {
    if (ctx.utilization < 0.8) return false
    // Do something with ctx.messages and ctx.stash
    return true
  },
}

new ContextManager({ strategies: [myStrategy] })
```

## Multimodal Summarization

The summarize strategy supports multimodal content natively. Images, documents, and other opaque blocks are passed directly to the summarizer model:

- If the model supports vision → images are included in the summary
- If the model doesn't support vision → automatically retries with text-only content
- Truncate preserves images untouched (can't slice a PNG)
- Drop destroys everything regardless of type
