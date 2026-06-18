import { describe, it, expect } from 'vitest'
import { basePriority, scoreMessages, extractFilePaths } from '../priority.js'
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

  it('boosts messages that reference a recently-accessed file', () => {
    const aboutFile = toolResult('success') // base tool_result = 40
    aboutFile.content.push(new TextBlock('inspected lib/mpl_toolkits/mplot3d/axes3d.py for the bug'))
    const unrelated = toolResult('success')
    unrelated.content.push(new TextBlock('ran unrelated diagnostics'))
    const recent = new Set(['lib/mpl_toolkits/mplot3d/axes3d.py', 'axes3d.py'])
    const scored = scoreMessages([aboutFile, unrelated], recent)
    expect(scored[0]!.priority).toBeGreaterThan(scored[1]!.priority)
  })

  it('adds a fixed working-set bonus to a file-referencing message', () => {
    const result = toolResult('success')
    result.content.push(new TextBlock('edited src/server/handler.go'))
    const recent = new Set(['src/server/handler.go', 'handler.go'])
    const before = scoreMessages([result])[0]!.priority
    const after = scoreMessages([result], recent)[0]!.priority
    expect(after).toBe(before + 50) // RECENT_FILE_WEIGHT
  })

  it('no recentFiles set leaves scoring unchanged', () => {
    const a = toolResult('success')
    a.content.push(new TextBlock('touches foo.py'))
    expect(scoreMessages([a])[0]!.priority).toBe(scoreMessages([a], new Set())[0]!.priority)
  })
})

describe('extractFilePaths', () => {
  it('extracts slashed paths and bare filenames, plus basenames', () => {
    const paths = extractFilePaths('see lib/foo/bar.py and also config.json')
    expect(paths.has('lib/foo/bar.py')).toBe(true)
    expect(paths.has('bar.py')).toBe(true)
    expect(paths.has('config.json')).toBe(true)
  })

  it('lowercases for case-insensitive matching', () => {
    expect(extractFilePaths('Axes3D.PY').has('axes3d.py')).toBe(true)
  })
})
