import { describe, it, expect } from 'vitest'
import { ContentRouter } from '../content-router.js'
import { DropMethod, ProtectMethod, TruncateMethod } from '../methods.js'
import { FallbackChain } from '../fallback-chain.js'
import { categorize } from '../content.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../../types/messages.js'
import type { CompressionMethod, TokenBudget } from '../types.js'

const BUDGET: TokenBudget = { limit: 1000, used: 900, remaining: 100, ratio: 0.9, target: 200 }

function userText(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}
function assistantText(text: string): Message {
  return new Message({ role: 'assistant', content: [new TextBlock(text)] })
}
function toolUse(): Message {
  return new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'f', toolUseId: 't1', input: {} })] })
}
function toolResult(status: 'success' | 'error'): Message {
  return new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status, content: [new TextBlock('out')] })],
  })
}

describe('categorize', () => {
  it('classifies messages by most-specific category', () => {
    expect(categorize(userText('hi'))).toBe('userMessages')
    expect(categorize(assistantText('hi'))).toBe('assistantMessages')
    expect(categorize(toolUse())).toBe('assistantMessages')
    expect(categorize(toolResult('success'))).toBe('toolResults')
    expect(categorize(toolResult('error'))).toBe('toolResultErrors')
  })
})

describe('ContentRouter', () => {
  it('dispatches each message to the route for its category', async () => {
    const router = new ContentRouter({
      userMessages: 'protect',
      toolResultErrors: new DropMethod(),
    })
    const out = await router.compress([userText('keep me'), toolResult('error')], BUDGET)
    expect(out).toHaveLength(1)
    expect((out[0]!.content[0] as TextBlock).text).toBe('keep me')
  })

  it('uses the default route for unmatched content', async () => {
    const router = new ContentRouter({ default: new DropMethod() })
    const out = await router.compress([assistantText('drop me')], BUDGET)
    expect(out).toHaveLength(0)
  })

  it('falls back to truncate when no default is set', async () => {
    const router = new ContentRouter({})
    const long = 'x'.repeat(8000)
    const [out] = await router.compress([userText(long)], BUDGET)
    expect((out!.content[0] as TextBlock).text.length).toBeLessThan(long.length)
  })

  it('groups consecutive same-route messages into one method call', async () => {
    let calls = 0
    const counting: CompressionMethod = {
      name: 'counting',
      async compress(messages) {
        calls++
        return messages
      },
    }
    const router = new ContentRouter({ userMessages: counting })
    await router.compress([userText('a'), userText('b'), userText('c')], BUDGET)
    expect(calls).toBe(1)
  })
})

describe('FallbackChain', () => {
  it('falls through to the next method when one throws', async () => {
    const failing: CompressionMethod = {
      name: 'failing',
      async compress() {
        throw new Error('boom')
      },
    }
    const chain = new FallbackChain([failing, new ProtectMethod()])
    const messages = [userText('survive')]
    const out = await chain.compress(messages, BUDGET)
    expect(out).toEqual(messages)
  })

  it('throws when every method fails', async () => {
    const failing: CompressionMethod = {
      name: 'failing',
      async compress() {
        throw new Error('boom')
      },
    }
    const chain = new FallbackChain([failing, failing])
    await expect(chain.compress([userText('x')], BUDGET)).rejects.toThrow('boom')
  })

  it('rejects an empty method list', () => {
    expect(() => new FallbackChain([])).toThrow('at least one method')
  })

  it('resolves string shorthands', async () => {
    const chain = new FallbackChain(['truncate'])
    const out = await chain.compress([userText('hi')], BUDGET)
    expect(out).toHaveLength(1)
    void new TruncateMethod()
  })
})
