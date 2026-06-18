import { describe, it, expect } from 'vitest'
import { basePriority, scoreMessages } from '../priority.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../../types/messages.js'

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

describe('basePriority', () => {
  it('ranks roles per the design: user > assistant > tool_use > tool_result > error', () => {
    expect(basePriority(userText('x'))).toBe(100)
    expect(basePriority(assistantText('x'))).toBe(80)
    expect(basePriority(toolUse())).toBe(60)
    expect(basePriority(toolResult('success'))).toBe(40)
    expect(basePriority(toolResult('error'))).toBe(10)
  })
})

describe('scoreMessages', () => {
  it('gives pinned messages Infinity priority', () => {
    const pinned = userText('pinned')
    pinned.metadata = { custom: { pinned: true } }
    const scored = scoreMessages([pinned, userText('plain')])
    expect(scored[0]!.priority).toBe(Infinity)
    expect(Number.isFinite(scored[1]!.priority)).toBe(true)
  })

  it('gives more recent messages a higher priority than older same-role ones', () => {
    const scored = scoreMessages([assistantText('old'), assistantText('mid'), assistantText('new')])
    expect(scored[2]!.priority).toBeGreaterThan(scored[0]!.priority)
  })
})
