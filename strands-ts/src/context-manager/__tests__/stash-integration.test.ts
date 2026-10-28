import { describe, it, expect } from 'vitest'
import { Offload } from '../strategies/offload/index.js'
import { Stash } from '../stash.js'
import { ContextManager } from '../context-manager.js'
import { createRetrievalTool, RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { PluginRegistry } from '../../plugins/registry.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { Message, OffloadedBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../types/media.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import type { Tool } from '../../tools/tool.js'
import type { ContextState } from '../types.js'

function invokeRetrievalTool(retrievalTool: Tool, input: unknown): Promise<unknown> {
  return (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke(input)
}

function makeToolResultMessage(text: string, toolUseId = 'tool-123'): Message {
  return new Message({
    role: 'user',
    content: [
      new ToolResultBlock({
        toolUseId,
        status: 'success',
        content: [new TextBlock(text)],
      }),
    ],
  })
}

function heuristicCountTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof TextBlock) {
        total += Math.ceil(block.text.length / 4)
      } else if (block instanceof ToolResultBlock) {
        for (const content of block.content) {
          if (content instanceof TextBlock) total += Math.ceil(content.text.length / 4)
          else total += Math.ceil(JSON.stringify(content).length / 2)
        }
      } else {
        total += Math.ceil(JSON.stringify(block).length / 2)
      }
    }
  }
  return total
}

async function stashAll(stash: Stash, messages: Message[]): Promise<void> {
  for (const message of messages) await stash.storeMessage(message)
}

function makeContext(messages: Message[], stash?: Stash, utilization = 0.5): ContextState {
  const agent = createMockAgent({
    messages,
    extra: { model: { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) } } as never,
  })
  const base: ContextState = {
    messages,
    agent,
    utilization,
  }
  if (stash) {
    return { ...base, stash }
  }
  return base
}

describe('ContextManager tool registration', () => {
  it('registers retrieve_context after plugin initialization', async () => {
    const contextManager = new ContextManager()
    const registry = new PluginRegistry([contextManager])
    const agent = createMockAgent()

    await registry.initialize(agent)

    expect(agent.toolRegistry.get(RETRIEVAL_TOOL_NAME)).toBeDefined()
  })

  it('does not register retrieve_context when stash is disabled', async () => {
    const contextManager = new ContextManager({ stash: false })
    const registry = new PluginRegistry([contextManager])
    const agent = createMockAgent()

    await registry.initialize(agent)

    expect(agent.toolRegistry.get(RETRIEVAL_TOOL_NAME)).toBeUndefined()
  })

  it('backfills stash from pre-existing messages at init', async () => {
    const largeText = 'restored content '.repeat(500)
    const messages = [makeToolResultMessage(largeText)]
    const contextManager = new ContextManager()
    const registry = new PluginRegistry([contextManager])
    const agent = createMockAgent({ messages })

    await registry.initialize(agent)

    const stash = contextManager.stash!
    const keys = await stash.list()
    expect(keys.length).toBe(1)
    const retrieved = await stash.retrieve(keys[0]!)
    expect((retrieved!.data as { text: string }).text).toBe(largeText)
  })
})

describe('Offload strategies with stash', () => {
  describe('truncate + stash', () => {
    it('persists original content to stash before truncating', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage, 'test-session', 'test-agent')
      const largeText = 'important data '.repeat(1000)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, stash)

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)

      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect(retrieved).not.toBeNull()
      expect((retrieved!.data as { text: string }).text).toBe(largeText)
    })

    it('leaves an OffloadedBlock referencing the tool result in the truncated preview', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, stash)

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      const placeholder = block.content[0] as OffloadedBlock
      expect(placeholder).toBeInstanceOf(OffloadedBlock)
      expect(placeholder.ref).toBe('tool-123')
      expect(placeholder.preview).toMatch(/^\[Truncated: .*\n\n\[Stashed\]$/s)
      expect(placeholder.toText()).toContain('[Stashed] [ref: tool-123]')
    })

    it('does not offload a tool result that already holds an OffloadedBlock', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const messages = [makeToolResultMessage('x'.repeat(20000))]
      await stashAll(stash, messages)
      const strategy = Offload.truncate('toolResults', { previewTokens: 10 })
      const context = makeContext(messages, stash)
      await strategy.apply(context)
      const once = (messages[0]!.content[0] as ToolResultBlock).content

      const actedAgain = await Offload.drop('toolResults').apply(context)

      expect(actedAgain).toBe(false)
      expect((messages[0]!.content[0] as ToolResultBlock).content).toBe(once)
    })

    it('does not stash when no stash is configured', async () => {
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages)

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      const text = (block.content[0] as TextBlock).text
      expect(text).not.toContain('[Stashed]')
    })
  })

  describe('drop + stash', () => {
    it('persists original content before dropping', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'critical information '.repeat(500)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, stash)

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)

      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect((retrieved!.data as { text: string }).text).toBe(largeText)
    })

    it('leaves an OffloadedBlock referencing the tool result as the drop marker', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, stash)

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      expect(block.content).toEqual([new OffloadedBlock({ ref: 'tool-123', preview: '[Dropped]' })])
      expect((block.content[0] as OffloadedBlock).toText()).toBe('[Dropped] [ref: tool-123]')
    })

    it('marks removed messages with an OffloadedBlock that retrieves them', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const text = (role: 'user' | 'assistant', content: string, trackingId: string): Message =>
        new Message({ role, content: [new TextBlock(content)], trackingId })
      const first = text('assistant', 'first answer', 'm1')
      const second = text('user', 'second question', 'm2')
      const messages = [text('user', 'start', 'm0'), first, second, text('assistant', 'final', 'm3')]
      await stashAll(stash, messages)
      const strategy = Offload.drop('*').when({ utilization: 0.5 })

      const acted = await strategy.apply(makeContext(messages, stash, 0.9))

      expect(acted).toBe(true)
      const marker = new OffloadedBlock({ ref: 'removed-m1', preview: '[Dropped: 2 messages]' })
      expect(messages.map((message) => message.content)).toEqual([
        [new TextBlock('start')],
        [new TextBlock('final'), marker],
      ])
      const retrieve = createRetrievalTool(stash)
      expect(await invokeRetrievalTool(retrieve, { reference: 'removed-m1' })).toEqual([
        first.toJSON(),
        second.toJSON(),
      ])
      expect(await invokeRetrievalTool(retrieve, { reference: 'removed-m1', pattern: 'second' })).toContain(
        'second question'
      )
    })

    it('leaves a text marker when there is no stash', async () => {
      const messages = [
        makeToolResultMessage('a', 't0'),
        new Message({ role: 'assistant', content: [new TextBlock('mid')] }),
        new Message({ role: 'user', content: [new TextBlock('next')] }),
        new Message({ role: 'assistant', content: [new TextBlock('final')] }),
      ]

      await Offload.drop('*')
        .when({ utilization: 0.5 })
        .apply(makeContext(messages, undefined, 0.9))

      expect(messages.at(-1)!.content).toEqual([new TextBlock('final'), new TextBlock('[Dropped: 2 messages]')])
    })
  })

  describe('binary content stashing', () => {
    it('stashes image content from tool results', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-img',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
            }),
          ],
        }),
      ]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, stash)

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)
      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect(retrieved).not.toBeNull()
      const data = retrieved!.data as { image: { format: string; source: { bytes: string } } }
      expect(data.image.format).toBe('png')
      expect(data.image.source.bytes).toBeDefined()
    })

    it('stashes each block independently when mixed content', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const imageBytes = new Uint8Array([0xff, 0xd8])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-mixed',
              status: 'success',
              content: [
                new TextBlock('description of image'),
                new ImageBlock({ format: 'jpeg', source: { bytes: imageBytes } }),
              ],
            }),
          ],
        }),
      ]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, stash)

      await strategy.apply(context)

      const keys = await stash.list()
      expect(keys.length).toBe(2)

      const entries = await Promise.all(keys.map((key) => stash.retrieve(key)))
      const textEntry = entries.find(
        (entry) => entry && typeof entry.data === 'object' && entry.data !== null && 'text' in entry.data
      )
      const imageEntry = entries.find(
        (entry) => entry && typeof entry.data === 'object' && entry.data !== null && 'image' in entry.data
      )

      expect(textEntry).not.toBeNull()
      expect((textEntry!.data as { text: string }).text).toBe('description of image')

      expect(imageEntry).not.toBeNull()
      expect((imageEntry!.data as { image: { format: string } }).image.format).toBe('jpeg')
    })
  })

  describe('eager stashing via storeMessage', () => {
    it('persists tool result content on message arrival', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'important data '.repeat(500)
      const message = makeToolResultMessage(largeText, 'call-1')

      await stash.storeMessage(message)

      const keys = await stash.list()
      expect(keys.length).toBe(1)
      const retrieved = await stash.retrieve(keys[0]!)
      expect(retrieved).not.toBeNull()
      expect((retrieved!.data as { text: string }).text).toBe(largeText)
    })

    it('persists text blocks from assistant messages on arrival', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const assistantText = 'important analysis '.repeat(200)
      const message = new Message({ role: 'assistant', content: [new TextBlock(assistantText)] })

      await stash.storeMessage(message)

      const keys = await stash.list()
      expect(keys.length).toBe(1)
      const retrieved = await stash.retrieve(keys[0]!)
      expect((retrieved!.data as { text: string }).text).toBe(assistantText)
    })
  })

  describe('media restoration in retrieval', () => {
    it('restores image blocks as ImageBlock instances', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-img',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
            }),
          ],
        }),
      ]
      await stashAll(stash, messages)

      const retrievalTool = createRetrievalTool(stash)
      const keys = await stash.list()
      const result = await invokeRetrievalTool(retrievalTool, { reference: keys[0]! })

      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as ImageBlock).format).toBe('png')
    })

    it('returns text content normally (not treated as media)', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const messages = [makeToolResultMessage('hello world')]
      await stashAll(stash, messages)

      const retrievalTool = createRetrievalTool(stash)
      const keys = await stash.list()
      const result = await invokeRetrievalTool(retrievalTool, { reference: keys[0]! })

      expect(result).toEqual({ text: 'hello world' })
    })

    it('restores document blocks as DocumentBlock instances', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const docData = { document: { format: 'pdf', source: { bytes: 'base64encodedcontent' } } }
      await stash.store('tool-doc', 0, new TextEncoder().encode(JSON.stringify(docData)))

      const retrievalTool = createRetrievalTool(stash)
      const keys = await stash.list()
      const result = await invokeRetrievalTool(retrievalTool, { reference: keys[0]! })

      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as DocumentBlock).format).toBe('pdf')
    })
  })

  describe('retrieval loop prevention', () => {
    it('does not offload retrieve_context tool results when stash is active', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeRetrievalResult = 'retrieved content '.repeat(1000)

      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'call-1', name: RETRIEVAL_TOOL_NAME, input: {} })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'call-1',
              status: 'success',
              content: [new TextBlock(largeRetrievalResult)],
            }),
          ],
        }),
      ]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, stash)

      const acted = await strategy.apply(context)

      expect(acted).toBe(false)
      const block = messages[1]!.content[0] as ToolResultBlock
      const text = (block.content[0] as TextBlock).text
      expect(text).toBe(largeRetrievalResult)
    })

    it('offloads retrieve_context results when no stash (stash not configured)', async () => {
      const largeRetrievalResult = 'retrieved content '.repeat(1000)

      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'call-1', name: RETRIEVAL_TOOL_NAME, input: {} })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'call-1',
              status: 'success',
              content: [new TextBlock(largeRetrievalResult)],
            }),
          ],
        }),
      ]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages)

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)
    })
  })
})
