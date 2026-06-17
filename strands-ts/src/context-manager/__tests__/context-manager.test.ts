import { describe, it, expect } from 'vitest'
import { ContextManager } from '../context-manager.js'
import { ContentRouter } from '../content-router.js'
import { OffloadMethod, DropMethod, SummarizeMethod } from '../methods.js'
import { InMemoryStorage } from '../../vended-plugins/context-offloader/storage.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { NullConversationManager } from '../../conversation-manager/null-conversation-manager.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import { AfterToolCallEvent } from '../../hooks/events.js'

/** Reach into private fields for white-box assertions. */
function peek(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>
}

describe('ContextManager construction', () => {
  it('defaults to the auto router method', () => {
    const cm = new ContextManager()
    expect(peek(cm)._method).toBeInstanceOf(ContentRouter)
  })

  it('accepts the "auto" preset', () => {
    const cm = new ContextManager({ preset: 'auto' })
    expect(peek(cm)._method).toBeInstanceOf(ContentRouter)
  })

  it('rejects an unsupported preset', () => {
    expect(() => new ContextManager({ preset: 'magic' as unknown as 'auto' })).toThrow(
      'Unsupported ContextManager preset'
    )
  })

  it('rejects an out-of-range threshold', () => {
    expect(() => new ContextManager({ threshold: 1.5 })).toThrow('threshold must be between')
  })

  it('exposes a zeroed budget before the first model call', () => {
    const cm = new ContextManager()
    expect(cm.budget).toEqual({ limit: 0, used: 0, remaining: 0, ratio: 0, target: 0 })
  })

  it('throws when accessing the transcript while disabled', () => {
    const cm = new ContextManager({ transcript: { enabled: false } })
    expect(() => cm.transcript).toThrow('Transcript is disabled')
  })

  it('injects its scratchpad into offload methods inside a router', () => {
    const offload = new OffloadMethod()
    const scratchpad = new InMemoryStorage()
    void new ContextManager({ method: new ContentRouter({ toolResults: offload }), scratchpad })
    expect(peek(offload)._scratchpad).toBe(scratchpad)
  })
})

describe('ContextManager as an Agent plugin', () => {
  function makeAgent(cm: ContextManager): Agent {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
    model.updateConfig({ contextWindowLimit: 1000 })
    return new Agent({ model, contextManager: cm, printer: false })
  }

  it('disables the ConversationManager when a ContextManager is set', () => {
    const agent = makeAgent(new ContextManager())
    expect(peek(agent)._conversationManager).toBeInstanceOf(NullConversationManager)
  })

  it('registers the ContextManager as a plugin', () => {
    const agent = makeAgent(new ContextManager())
    const registry = peek(agent)._pluginRegistry as { _pending: Array<{ name: string }> }
    expect(registry._pending.find((p) => p.name === 'strands:context-manager')).toBeDefined()
  })

  it('exposes the context manager on agent.contextManager', () => {
    const cm = new ContextManager()
    const agent = makeAgent(cm)
    expect(agent.contextManager).toBe(cm)
  })

  it('accepts a config object and wraps it in a ContextManager', () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
    const agent = new Agent({ model, contextManager: { preset: 'auto', threshold: 0.9 }, printer: false })
    expect(agent.contextManager).toBeInstanceOf(ContextManager)
  })

  it('rejects a ContextManager together with a conversationManager', () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
    expect(
      () =>
        new Agent({
          model,
          contextManager: new ContextManager(),
          conversationManager: new NullConversationManager(),
          printer: false,
        })
    ).toThrow('cannot be used together')
  })

  it('registers retrieval tools when transcript retrieval is enabled', async () => {
    const cm = new ContextManager()
    const agent = makeAgent(cm)
    await agent.initialize()
    const toolNames = agent.toolRegistry.list().map((t) => t.name)
    expect(toolNames).toContain('get_history')
    expect(toolNames).toContain('search_history')
  })

  it('does not register retrieval tools when disabled', async () => {
    const cm = new ContextManager({ transcript: { retrieval: false } })
    const agent = makeAgent(cm)
    await agent.initialize()
    const toolNames = agent.toolRegistry.list().map((t) => t.name)
    expect(toolNames).not.toContain('get_history')
  })
})

describe('ContextManager.compress', () => {
  it('throws before the agent is initialized', async () => {
    const cm = new ContextManager()
    await expect(cm.compress()).rejects.toThrow('before the agent was initialized')
  })

  it('preserves evicted messages to L1 and shrinks the conversation', async () => {
    const scratchpad = new InMemoryStorage()
    const cm = new ContextManager({
      method: new ContentRouter({ assistantMessages: new DropMethod(), userMessages: 'protect' }),
      scratchpad,
      protectFirst: 0,
      threshold: 0.85,
    })
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
    model.updateConfig({ contextWindowLimit: 1000 })
    const agent = new Agent({ model, contextManager: cm, printer: false })
    await agent.initialize()

    agent.messages.push(
      new Message({ role: 'user', content: [new TextBlock('keep me')] }),
      new Message({ role: 'assistant', content: [new TextBlock('drop me, I am verbose '.repeat(50))] })
    )

    const before = agent.messages.length
    await cm.compress()
    expect(agent.messages.length).toBeLessThan(before)
    // The dropped assistant message is not written to L1 (drop discards); the
    // user message is protected, so the transcript should be empty.
    const recent = await cm.transcript.getRecent(10)
    expect(recent.every((m) => m.role !== 'assistant')).toBe(true)
  })

  it('pin and unpin toggle the pinned metadata flag', async () => {
    const cm = new ContextManager()
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
    const agent = new Agent({ model, contextManager: cm, printer: false })
    await agent.initialize()
    agent.messages.push(new Message({ role: 'user', content: [new TextBlock('x')] }))
    const idx = agent.messages.length - 1
    cm.pin(idx)
    expect(agent.messages[idx]!.metadata?.custom?.pinned).toBe(true)
    cm.unpin(idx)
    expect(agent.messages[idx]!.metadata?.custom?.pinned).toBeUndefined()
  })
})

describe('ContextManager eager tool-result offload (design §6.3)', () => {
  function makeEvent(agent: Agent, toolName: string, result: ToolResultBlock): AfterToolCallEvent {
    return new AfterToolCallEvent({
      agent,
      toolUse: { name: toolName, toolUseId: result.toolUseId, input: {} },
      tool: undefined,
      result,
      invocationState: {} as never,
    })
  }

  async function setup(): Promise<{ cm: ContextManager; agent: Agent }> {
    const cm = new ContextManager({
      method: new ContentRouter({ toolResults: new OffloadMethod({ threshold: 1, keepRecent: 0 }) }),
      scratchpad: new InMemoryStorage(),
    })
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
    model.updateConfig({ contextWindowLimit: 1000 })
    const agent = new Agent({ model, contextManager: cm, printer: false })
    await agent.initialize()
    return { cm, agent }
  }

  it('persists the original tool result to L1 before offloading it (design §2.2)', async () => {
    const { cm, agent } = await setup()
    const original = new ToolResultBlock({
      toolUseId: 't1',
      status: 'success',
      content: [new TextBlock('X'.repeat(8000))],
    })
    const event = makeEvent(agent, 'read_file', original)
    await (cm as unknown as { _maybeOffloadToolResult(e: AfterToolCallEvent): Promise<void> })._maybeOffloadToolResult(
      event
    )

    // L0 result was shrunk to a preview...
    expect(JSON.stringify(event.result.toJSON()).length).toBeLessThan(8000)
    // ...and the full original was preserved to L1.
    const recent = await cm.transcript.getRecent(1)
    expect(JSON.stringify(recent[0]!.toJSON())).toContain('X'.repeat(8000))
  })

  it('never re-compresses results from the L1 retrieval tools', async () => {
    const { cm, agent } = await setup()
    const retrieved = new ToolResultBlock({
      toolUseId: 't2',
      status: 'success',
      content: [new TextBlock('Y'.repeat(8000))],
    })
    const event = makeEvent(agent, 'get_history', retrieved)
    await (cm as unknown as { _maybeOffloadToolResult(e: AfterToolCallEvent): Promise<void> })._maybeOffloadToolResult(
      event
    )
    // Untouched: same block, nothing written to L1.
    expect(event.result).toBe(retrieved)
    expect(await cm.transcript.getRecent(1)).toHaveLength(0)
  })
})

describe('ContextManager auto-preset summarize wiring', () => {
  it('supplies the agent model to a summarize route lacking one', async () => {
    const summarize = new SummarizeMethod()
    expect(summarize.model).toBeUndefined()
    const cm = new ContextManager({ method: new ContentRouter({ assistantMessages: summarize }) })
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'summary' })
    model.updateConfig({ contextWindowLimit: 1000 })
    const agent = new Agent({ model, contextManager: cm, printer: false })
    await agent.initialize()
    agent.messages.push(new Message({ role: 'assistant', content: [new TextBlock('verbose '.repeat(100))] }))
    await cm.compress()
    expect(summarize.model).toBe(model)
  })
})
