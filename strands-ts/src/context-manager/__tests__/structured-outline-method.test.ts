import { describe, it, expect } from 'vitest'
import { StructuredOutlineMethod } from '../structured-outline-method.js'
import { InMemoryStorage } from '../../vended-plugins/context-offloader/storage.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { TokenBudget } from '../types.js'

const BUDGET: TokenBudget = { limit: 200_000, used: 190_000, remaining: 10_000, ratio: 0.95, target: 20_000 }

function toolResultMsg(text: string): Message {
  return new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock(text)] })],
  })
}
function textOf(m: Message): string {
  const tr = m.content[0] as ToolResultBlock
  return (tr.content[0] as TextBlock).text
}

describe('StructuredOutlineMethod', () => {
  it('routes grep output to the grep outline (locations, not content)', async () => {
    const grep = Array.from({ length: 40 }, (_, i) => `src/app.ts:${i}:        const secret_${i} = compute()`).join(
      '\n'
    )
    const [out] = await new StructuredOutlineMethod({ threshold: 1 }).compress([toolResultMsg(grep)], BUDGET)
    const t = textOf(out!)
    expect(t).toContain('grep outline')
    expect(t).toContain('src/app.ts:0')
    expect(t).not.toContain('secret_0 = compute')
  })

  it('routes a directory listing to the tree outline', async () => {
    const ls = Array.from({ length: 40 }, (_, i) => `-rw-r--r--  1 u g 1024 Jan 1 12:00 file_${i}.ts`).join('\n')
    const [out] = await new StructuredOutlineMethod({ threshold: 1 }).compress([toolResultMsg(ls)], BUDGET)
    const t = textOf(out!)
    expect(t).toContain('directory outline')
    expect(t).toContain('file_0.ts')
    expect(t).not.toContain('1024')
  })

  it('routes tabular data to the table outline', async () => {
    const csv = ['id,name,active', ...Array.from({ length: 40 }, (_, i) => `${i},user${i},true`)].join('\n')
    const [out] = await new StructuredOutlineMethod({ threshold: 1 }).compress([toolResultMsg(csv)], BUDGET)
    const t = textOf(out!)
    expect(t).toContain('table outline')
    expect(t).toContain('id: int')
    expect(t).not.toContain('user0')
  })

  it('routes code to skeleton (signatures kept, bodies dropped)', async () => {
    const code = [
      'function foo(a, b) {',
      ...Array.from({ length: 30 }, (_, i) => `  const step_${i} = a + b + ${i}`),
      '  return step_0',
      '}',
    ].join('\n')
    const [out] = await new StructuredOutlineMethod({ threshold: 1 }).compress([toolResultMsg(code)], BUDGET)
    const t = textOf(out!)
    expect(t).toContain('function foo(a, b) {')
    expect(t).not.toContain('step_15')
  })

  it('keeps the most recent keepRecent messages verbatim', async () => {
    const big = 'src/x.ts:1: ' + 'x'.repeat(8000)
    const m = new StructuredOutlineMethod({ threshold: 1, keepRecent: 1 })
    const out = await m.compress([toolResultMsg(big), toolResultMsg(big)], BUDGET)
    expect(textOf(out[1]!)).toBe(big) // recent kept verbatim
  })

  it('leaves small (below-threshold) content untouched', async () => {
    const small = toolResultMsg('src/a.ts:1: tiny')
    const [out] = await new StructuredOutlineMethod({ threshold: 100_000 }).compress([small], BUDGET)
    expect(textOf(out!)).toBe('src/a.ts:1: tiny')
  })

  it('routes unstructured prose to the fallback offload (preserved + reference)', async () => {
    const prose = 'The quick brown fox. ' + 'Lorem ipsum dolor sit amet. '.repeat(400)
    const method = new StructuredOutlineMethod({ threshold: 1 })
    method.setScratchpad(new InMemoryStorage())
    const [out] = await method.compress([toolResultMsg(prose)], BUDGET)
    expect(textOf(out!)).toContain('Offloaded')
  })
})
