import { describe, it, expect } from 'vitest'
import {
  ProtectMethod,
  TruncateMethod,
  DropMethod,
  OffloadMethod,
  SkeletonMethod,
  SchemaOnlyMethod,
  CollapsePairsMethod,
  resolveMethod,
  resolveMethodShorthand,
} from '../methods.js'
import { InMemoryStorage } from '../../vended-plugins/context-offloader/storage.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { TokenBudget } from '../types.js'

function userText(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

const BUDGET: TokenBudget = { limit: 1000, used: 900, remaining: 100, ratio: 0.9, target: 200 }

describe('ProtectMethod', () => {
  it('returns messages unchanged', async () => {
    const messages = [userText('hello')]
    const out = await new ProtectMethod().compress(messages, BUDGET)
    expect(out).toEqual(messages)
  })
})

describe('TruncateMethod', () => {
  it('keeps a head-tail slice of long text', async () => {
    const long = 'A'.repeat(400) + 'MIDDLE'.repeat(200) + 'Z'.repeat(400)
    const [out] = await new TruncateMethod({ keep: 'head-tail', tokens: 20 }).compress([userText(long)], BUDGET)
    const text = (out!.content[0] as TextBlock).text
    expect(text.length).toBeLessThan(long.length)
    expect(text).toContain('chars elided')
  })

  it('keeps only the tail when configured', async () => {
    const text = 'start ' + 'x'.repeat(1000) + ' END'
    const [out] = await new TruncateMethod({ keep: 'tail', tokens: 10 }).compress([userText(text)], BUDGET)
    expect((out!.content[0] as TextBlock).text).toContain('END')
  })

  it('appends the recovery hint to output when one is set', async () => {
    const method = new TruncateMethod({ tokens: 10 })
    method.setRecoveryHint('recover with search_history(query) or get_history().')
    const [out] = await method.compress([userText('x'.repeat(1000))], BUDGET)
    expect((out!.content[0] as TextBlock).text).toContain('search_history')
  })

  it('omits the recovery hint when none is set', async () => {
    const [out] = await new TruncateMethod({ tokens: 10 }).compress([userText('x'.repeat(1000))], BUDGET)
    expect((out!.content[0] as TextBlock).text).not.toContain('search_history')
  })
})

describe('DropMethod', () => {
  it('drops all candidates by default', async () => {
    const out = await new DropMethod().compress([userText('a'), userText('b')], BUDGET)
    expect(out).toHaveLength(0)
  })

  it('keeps the most recent N', async () => {
    const out = await new DropMethod({ keepLast: 1 }).compress([userText('a'), userText('b')], BUDGET)
    expect(out).toHaveLength(1)
    expect((out[0]!.content[0] as TextBlock).text).toBe('b')
  })
})

describe('OffloadMethod', () => {
  it('replaces large messages with a preview + reference and persists the original', async () => {
    const storage = new InMemoryStorage()
    const method = new OffloadMethod({ scratchpad: storage, threshold: 1, previewTokens: 5 })
    const big = userText('B'.repeat(5000))
    const [out] = await method.compress([big], BUDGET)
    const text = (out!.content[0] as TextBlock).text
    expect(text).toContain('Offloaded')
    expect(text).toMatch(/ref:\s*mem_/)
  })

  it('never offloads the most recent keepRecent messages', async () => {
    const storage = new InMemoryStorage()
    const method = new OffloadMethod({ scratchpad: storage, threshold: 1, keepRecent: 1 })
    const a = userText('A'.repeat(5000))
    const b = userText('B'.repeat(5000))
    const out = await method.compress([a, b], BUDGET)
    expect((out[1]!.content[0] as TextBlock).text).toBe('B'.repeat(5000))
  })

  it('falls back to preview-only when no scratchpad is available', async () => {
    const method = new OffloadMethod({ threshold: 1, previewTokens: 5 })
    const [out] = await method.compress([userText('C'.repeat(5000))], BUDGET)
    const text = (out!.content[0] as TextBlock).text
    expect(text.length).toBeLessThan(5000)
    expect(text).not.toContain('ref: mem_')
  })
})

describe('SkeletonMethod', () => {
  it('drops function bodies but keeps signatures', async () => {
    const code = ['function foo(a, b) {', '  const x = a + b', '  return x', '}'].join('\n')
    const [out] = await new SkeletonMethod().compress([userText(code)], BUDGET)
    const text = (out!.content[0] as TextBlock).text
    expect(text).toContain('function foo(a, b) {')
    expect(text).toContain('// ...')
    expect(text).not.toContain('const x = a + b')
  })
})

describe('SchemaOnlyMethod', () => {
  it('replaces JSON scalar values with their type names', async () => {
    const json = JSON.stringify({ id: 123, name: 'alice', tags: ['x', 'y'], active: true })
    const [out] = await new SchemaOnlyMethod().compress([userText(json)], BUDGET)
    const parsed = JSON.parse((out!.content[0] as TextBlock).text)
    expect(parsed).toEqual({ id: 'number', name: 'string', tags: ['string'], active: 'boolean' })
  })

  it('leaves non-JSON content unchanged', async () => {
    const [out] = await new SchemaOnlyMethod().compress([userText('not json')], BUDGET)
    expect((out!.content[0] as TextBlock).text).toBe('not json')
  })
})

describe('CollapsePairsMethod', () => {
  it('collapses a turn into a one-line summary', async () => {
    const msg = new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 't1',
          status: 'success',
          content: [new TextBlock('lots of output\nacross lines')],
        }),
      ],
    })
    const [out] = await new CollapsePairsMethod().compress([msg], BUDGET)
    const text = (out!.content[0] as TextBlock).text
    expect(text).toContain('[collapsed user turn]')
    expect(text).not.toContain('\n')
  })
})

describe('resolveMethodShorthand', () => {
  it('maps every shorthand to a method with the matching name', () => {
    const shorthands = [
      'protect',
      'summarize',
      'truncate',
      'offload',
      'drop',
      'skeleton',
      'schema-only',
      'collapse-pairs',
    ] as const
    for (const s of shorthands) {
      expect(resolveMethodShorthand(s).name).toBe(s)
    }
  })

  it('resolveMethod passes through instances', () => {
    const instance = new ProtectMethod()
    expect(resolveMethod(instance)).toBe(instance)
  })
})
