import { describe, it, expect } from 'vitest'
import { Offload } from '../strategies/offload.js'
import { Stash } from '../stash.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import type { ContextState } from '../types.js'

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

function makeContext(messages: Message[], stash?: Stash, utilization = 0.5): ContextState {
  const agent = createMockAgent({
    messages,
    extra: { model: { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) } },
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

describe('Offload strategies with stash', () => {
  describe('truncate + stash', () => {
    it('persists original content to stash before truncating', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage)
      const largeText = 'important data '.repeat(1000)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, stash)

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)

      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect(retrieved).not.toBeNull()
      expect(new TextDecoder().decode(retrieved!.content)).toBe(largeText)
    })

    it('includes stash reference in the truncated preview', async () => {
      const stash = new Stash(new InMemoryStorage())
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, stash)

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      const text = (block.content[0] as TextBlock).text
      expect(text).toContain('[Stashed: ref=')
    })

    it('does not stash when no stash is configured', async () => {
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages)

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      const text = (block.content[0] as TextBlock).text
      expect(text).not.toContain('[Stashed:')
    })
  })

  describe('drop + stash', () => {
    it('persists original content before dropping', async () => {
      const stash = new Stash(new InMemoryStorage())
      const largeText = 'critical information '.repeat(500)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, stash)

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)

      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect(new TextDecoder().decode(retrieved!.content)).toBe(largeText)
    })

    it('includes stash reference in the drop marker', async () => {
      const stash = new Stash(new InMemoryStorage())
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, stash)

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      const text = (block.content[0] as TextBlock).text
      expect(text).toContain('[Dropped] ref:')
    })
  })

  describe('eager hook + stash', () => {
    it('stashes content on message arrival via init', async () => {
      const stash = new Stash(new InMemoryStorage())
      const strategy = Offload.truncate('toolResults')
      const messages: Message[] = []
      const agent = createMockAgent({
        messages,
        extra: { model: { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) } },
      })

      strategy.init!(agent, stash)

      const largeText = 'eager data '.repeat(1000)
      const message = makeToolResultMessage(largeText)
      messages.push(message)

      const hook = agent.trackedHooks.find((h) => h.eventType.name === 'MessageAddedEvent')
      expect(hook).toBeDefined()
      await hook!.callback({ message } as never)

      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect(new TextDecoder().decode(retrieved!.content)).toBe(largeText)
    })
  })

  describe('message-level offload + stash', () => {
    it('truncate message-level stashes content and includes refs in marker', async () => {
      const { ToolUseBlock } = await import('../../types/messages.js')
      const storage = new InMemoryStorage()
      const stash = new Stash(storage)
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'tool-1', name: 'bash', input: {} })],
        }),
        makeToolResultMessage('stashable content', 'tool-1'),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'tool-2', name: 'bash', input: {} })],
        }),
        makeToolResultMessage('more stashable content', 'tool-2'),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'tool-3', name: 'bash', input: {} })],
        }),
        makeToolResultMessage('even more content', 'tool-3'),
        new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
        new Message({ role: 'user', content: [new TextBlock('latest')] }),
        new Message({ role: 'assistant', content: [new TextBlock('a5')] }),
      ]
      const strategy = Offload.truncate('*').when({ utilization: 0.5 })
      const context = makeContext(messages, stash, 0.9)

      await strategy.apply(context)

      const keys = await stash.list()
      expect(keys.length).toBeGreaterThan(0)

      const allText = messages.flatMap((message) =>
        message.content.filter((block): block is TextBlock => block instanceof TextBlock).map((block) => block.text)
      )
      const marker = allText.find((text) => text.includes('[...') && text.includes('elided'))
      expect(marker).toBeDefined()
      expect(marker).toContain('refs:')
    })

    it('drop message-level stashes content but marker has no refs', async () => {
      const { ToolUseBlock } = await import('../../types/messages.js')
      const storage = new InMemoryStorage()
      const stash = new Stash(storage)
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'tool-1', name: 'bash', input: {} })],
        }),
        makeToolResultMessage('stashable content', 'tool-1'),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'tool-2', name: 'bash', input: {} })],
        }),
        makeToolResultMessage('more stashable', 'tool-2'),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'tool-3', name: 'bash', input: {} })],
        }),
        makeToolResultMessage('even more', 'tool-3'),
        new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
        new Message({ role: 'user', content: [new TextBlock('latest')] }),
        new Message({ role: 'assistant', content: [new TextBlock('a5')] }),
      ]
      const strategy = Offload.drop('*').when({ utilization: 0.5 })
      const context = makeContext(messages, stash, 0.9)

      await strategy.apply(context)

      const keys = await stash.list()
      expect(keys.length).toBeGreaterThan(0)

      const allText = messages.flatMap((message) =>
        message.content.filter((block): block is TextBlock => block instanceof TextBlock).map((block) => block.text)
      )
      const marker = allText.find((text) => text.includes('[Dropped:'))
      expect(marker).toBeDefined()
      expect(marker).not.toContain('refs:')
    })
  })
})
