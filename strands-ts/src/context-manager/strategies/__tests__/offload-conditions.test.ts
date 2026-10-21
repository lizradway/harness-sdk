import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Offload } from '../offload/index.js'
import { EmergencyTruncateStrategy, parseCondition } from '../offload/base.js'
import type { OffloadConditions, OffloadTarget } from '../offload/base.js'
import { summarizeContent } from '../../methods/summarize.js'
import { TRUNCATED_PREFIX } from '../../methods/truncate.js'
import type { TruncateConfig } from '../../methods/truncate.js'
import { MessageAddedEvent } from '../../../hooks/events.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { Role } from '../../../types/messages.js'
import { createMockAgent, invokeTrackedHook } from '../../../__fixtures__/agent-helpers.js'
import type { MockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState, ContextStrategy } from '../../types.js'

vi.mock('../../methods/summarize.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, summarizeContent: vi.fn(async () => 'summary') }
})

beforeEach(() => {
  vi.mocked(summarizeContent).mockClear()
})

/** One token per four characters, matching the SDK's text heuristic. */
function countTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof TextBlock) total += Math.ceil(block.text.length / 4)
      if (block instanceof ToolResultBlock) {
        for (const content of block.content) {
          if (content instanceof TextBlock) total += Math.ceil(content.text.length / 4)
        }
      }
    }
  }
  return total
}

function makeAgent(messages: Message[], contextWindowLimit?: number): MockAgent {
  const config = contextWindowLimit === undefined ? {} : { contextWindowLimit }
  const model = { countTokens: async (input: Message[]) => countTokens(input), getConfig: () => config }
  return createMockAgent({ messages, extra: { model } as unknown as Partial<Agent> })
}

function makeContext(messages: Message[], utilization: number, contextWindowLimit?: number): ContextState {
  return { messages, agent: makeAgent(messages, contextWindowLimit), utilization }
}

function text(role: Role, value: string, pinned = false): Message {
  return new Message({
    role,
    content: [new TextBlock(value)],
    ...(pinned ? { metadata: { custom: { pinned: true } } } : {}),
  })
}

function toolResult(toolUseId: string, value: string): Message {
  return new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock(value)] })],
  })
}

/** A task message followed by one tool call per result, each result `tokens[i]` tokens long. */
function toolHistory(tokens: number[]): Message[] {
  const messages = [text('user', 'task')]
  tokens.forEach((size, index) => {
    messages.push(
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ toolUseId: `tu-${index}`, name: 'read', input: {} })],
      }),
      toolResult(`tu-${index}`, 'x'.repeat(size * 4))
    )
  })
  messages.push(text('assistant', 'done'))
  return messages
}

function resultTexts(messages: Message[]): string[] {
  return messages.flatMap((message) =>
    message.content
      .filter((block): block is ToolResultBlock => block instanceof ToolResultBlock)
      .map((block) => (block.content[0] as TextBlock).text)
  )
}

function textsOf(messages: Message[]): string[][] {
  return messages.map((message) => message.content.map((block) => (block as TextBlock).text))
}

describe('parseCondition', () => {
  it.each([
    ['utilization', 0.5, { value: 0.5, isShare: true }],
    ['utilization', 1, { value: 1, isShare: true }],
    ['utilization', '70%', { value: 0.7, isShare: true }],
    ['utilization', '12.5%', { value: 0.125, isShare: true }],
    ['utilization', '100%', { value: 1, isShare: true }],
    ['utilization', 50_000, { value: 50_000, isShare: false }],
    ['blockThreshold', 0, { value: 0, isShare: false }],
    ['blockThreshold', 2500, { value: 2500, isShare: false }],
    ['blockThreshold', '5%', { value: 0.05, isShare: true }],
    ['blockThreshold', '100%', { value: 1, isShare: true }],
    ['preserveRecent', 0, { value: 0, isShare: false }],
    ['preserveRecent', 4, { value: 4, isShare: false }],
    ['preserveRecent', 0.5, { value: 0.5, isShare: true }],
    ['preserveRecent', '0%', { value: 0, isShare: true }],
    ['preserveRecent', '50%', { value: 0.5, isShare: true }],
    ['preserveRecent', '99.5%', { value: 0.995, isShare: true }],
  ] as const)('accepts %s=%j', (name, raw, expected) => {
    expect(parseCondition(name, raw)).toEqual(expected)
  })

  it.each(['utilization', 'blockThreshold', 'preserveRecent'] as const)('leaves %s unset when undefined', (name) => {
    expect(parseCondition(name, undefined)).toBeUndefined()
  })

  it.each([
    ['utilization', true, 'true'],
    ['utilization', Number.NaN, 'NaN'],
    ['utilization', Number.POSITIVE_INFINITY, 'Infinity'],
    ['utilization', -0.5, '-0.5'],
    ['utilization', 0, '0'],
    ['utilization', 1.5, '1.5'],
    ['utilization', '0%', '"0%"'],
    ['utilization', '101%', '"101%"'],
    ['utilization', '-5%', '"-5%"'],
    ['utilization', '70', '"70"'],
    ['utilization', ' 70%', '" 70%"'],
    ['utilization', '.5%', '".5%"'],
    ['blockThreshold', false, 'false'],
    ['blockThreshold', Number.NaN, 'NaN'],
    ['blockThreshold', -1, '-1'],
    ['blockThreshold', 0.5, '0.5'],
    ['blockThreshold', 1.5, '1.5'],
    ['blockThreshold', '0%', '"0%"'],
    ['blockThreshold', '101%', '"101%"'],
    ['blockThreshold', '2500', '"2500"'],
    ['preserveRecent', true, 'true'],
    ['preserveRecent', Number.NEGATIVE_INFINITY, '-Infinity'],
    ['preserveRecent', -1, '-1'],
    ['preserveRecent', 1.5, '1.5'],
    ['preserveRecent', '100%', '"100%"'],
    ['preserveRecent', 'half%', '"half%"'],
  ] as const)('rejects %s=%s', (name, raw, shown) => {
    expect(() => parseCondition(name, raw)).toThrow(`${name}=${shown} is invalid: expected `)
  })

  it('names the accepted forms in the error', () => {
    expect(() => parseCondition('utilization', 1.5)).toThrow(
      'utilization=1.5 is invalid: expected a "N%" string up to "100%", a fraction in (0, 1], or a whole token count'
    )
    expect(() => parseCondition('blockThreshold', 1.5)).toThrow(
      'blockThreshold=1.5 is invalid: expected a whole token count or a "N%" string up to "100%"'
    )
    expect(() => parseCondition('preserveRecent', 1.5)).toThrow(
      'preserveRecent=1.5 is invalid: expected a whole message count, a "N%" string below "100%", or a fraction in [0, 1)'
    )
  })

  it('validates conditions when the strategy is built', () => {
    expect(() => Offload.drop('toolResults').when({ utilization: '150%' as `${number}%` })).toThrow(
      'utilization="150%" is invalid'
    )
  })
})

describe('percent and token resolution', () => {
  it.each([
    ['70%', 0.7, true],
    ['70%', 0.69, false],
    [0.7, 0.7, true],
    [0.7, 0.69, false],
  ] as const)('utilization=%j fires at %s: %s', async (utilization, current, fires) => {
    const strategy = Offload.drop('toolResults').when({ utilization })
    expect(await strategy.apply(makeContext(toolHistory([10]), current))).toBe(fires)
  })

  it.each([
    [100_000, 0.5, true],
    [100_000, 0.49, false],
    [undefined, 0.25, true],
    [undefined, 0.24, false],
  ] as const)(
    'utilization of 50,000 tokens against a %s-token window fires at %s: %s',
    async (contextWindowLimit, current, fires) => {
      const strategy = Offload.drop('toolResults').when({ utilization: 50_000 })
      expect(await strategy.apply(makeContext(toolHistory([10]), current, contextWindowLimit))).toBe(fires)
    }
  )

  it.each([
    [10_000, 100],
    [undefined, 2000],
  ] as const)(
    'blockThreshold="1%" against a %s-token window offloads only blocks over %s tokens',
    async (contextWindowLimit, threshold) => {
      const messages = toolHistory([threshold, threshold + 1])
      const strategy = Offload.drop('toolResults').when({ blockThreshold: '1%' })

      expect(await strategy.apply(makeContext(messages, 0, contextWindowLimit))).toBe(true)

      expect(resultTexts(messages)).toEqual(['x'.repeat(threshold * 4), '[Dropped]'])
    }
  )

  it.each(['50%', 0.5] as const)('preserveRecent=%j keeps the newest half of the matches', async (preserveRecent) => {
    const messages = toolHistory([10, 10, 10, 10])
    const strategy = Offload.drop('toolResults').when({ preserveRecent })

    expect(await strategy.apply(makeContext(messages, 0))).toBe(true)

    expect(resultTexts(messages)).toEqual(['[Dropped]', '[Dropped]', 'x'.repeat(40), 'x'.repeat(40)])
  })

  it('resolves a percent blockThreshold against the window in the eager hook', async () => {
    const messages = toolHistory([101])
    const agent = makeAgent(messages, 10_000)
    const strategy = Offload.drop('toolResults').when({ blockThreshold: '1%' })
    strategy.init?.(agent)

    await invokeTrackedHook(agent, new MessageAddedEvent({ agent, message: messages[2]!, invocationState: {} }))

    expect(resultTexts(messages)).toEqual(['[Dropped]'])
  })
})

describe('eager hook registration', () => {
  it.each([
    ['toolResults', {}, 1],
    ['toolResults', { blockThreshold: 100 }, 1],
    ['*', { blockThreshold: 0 }, 1],
    ['toolResults', { utilization: 0.5 }, 0],
    ['toolResults', { preserveRecent: 2 }, 0],
    ['*', { utilization: 0.5 }, 0],
    ['*', { preserveRecent: 2 }, 0],
  ] as const)('drop(%j).when(%j) registers %s hooks', (target, conditions, hooks) => {
    const agent = makeAgent([])
    Offload.drop(target).when(conditions).init?.(agent)
    expect(agent.trackedHooks).toHaveLength(hooks)
  })
})

describe('granularity', () => {
  const BIG = 'x'.repeat(4000)
  const MESSAGE_MARKERS = { drop: '[Dropped: ', truncate: 'elided', summarize: '[Summarized: ' }
  const BLOCK_PREFIXES = { drop: '[Dropped]', truncate: TRUNCATED_PREFIX, summarize: '[Summarized: ' }
  const BUILDERS = {
    drop: (target: OffloadTarget) => Offload.drop(target),
    truncate: (target: OffloadTarget) => Offload.truncate(target, { previewTokens: 100 }),
    summarize: (target: OffloadTarget) => Offload.summarize(target),
  }

  function history(): Message[] {
    return [
      text('user', 'task'),
      text('assistant', BIG),
      text('user', BIG),
      text('assistant', BIG),
      text('user', BIG),
      text('assistant', 'end'),
      text('user', 'next'),
    ]
  }

  describe.each(['drop', 'truncate', 'summarize'] as const)('%s', (method) => {
    it.each([
      ['*', { utilization: 0.5 }, 0.9, 'messages'],
      ['*', { preserveRecent: 1 }, 0, 'messages'],
      ['*', { utilization: 0.5 }, 0.1, 'nothing'],
      ['*', { blockThreshold: 200 }, 0, [1, 2, 3, 4]],
      ['*', { blockThreshold: 200, utilization: 0.5 }, 0.9, [1, 2, 3, 4]],
      ['*', { blockThreshold: 200, utilization: 0.5 }, 0.1, 'nothing'],
      ['assistantText', {}, 0, [1, 3]],
      ['assistantText', { utilization: 0.5 }, 0.9, [1, 3]],
      ['assistantText', { utilization: 0.5 }, 0.1, 'nothing'],
    ] as [OffloadTarget, OffloadConditions, number, 'messages' | 'nothing' | number[]][])(
      'target=%j with %j at utilization %s acts on %j',
      async (target, conditions, utilization, outcome) => {
        const messages = history()
        const acted = await BUILDERS[method](target).when(conditions).apply(makeContext(messages, utilization))

        if (outcome === 'nothing') {
          expect(acted).toBe(false)
          expect(textsOf(messages)).toEqual(textsOf(history()))
          return
        }
        expect(acted).toBe(true)
        if (outcome === 'messages') {
          expect(messages.length).toBeLessThan(history().length)
          expect(textsOf(messages).flat().join('\n')).toContain(MESSAGE_MARKERS[method])
          return
        }
        expect(messages).toHaveLength(history().length)
        for (const index of [1, 2, 3, 4]) {
          const blockText = (messages[index]!.content[0] as TextBlock).text
          if (outcome.includes(index)) expect(blockText.startsWith(BLOCK_PREFIXES[method])).toBe(true)
          else expect(blockText).toBe(BIG)
        }
      }
    )
  })
})

describe('truncate per block', () => {
  it('uses previewTokens as the default blockThreshold', async () => {
    const messages = toolHistory([100, 200])
    const strategy = Offload.truncate('toolResults', { previewTokens: 100 }).when({})

    expect(await strategy.apply(makeContext(messages, 0))).toBe(true)

    const [kept, truncated] = resultTexts(messages)
    expect(kept).toBe('x'.repeat(400))
    expect(truncated!.startsWith(TRUNCATED_PREFIX)).toBe(true)
  })

  it.each([
    ['toolResults', () => toolHistory([2000])],
    ['assistantText', () => [text('user', 'task'), text('assistant', 'x'.repeat(8000)), text('user', 'next')]],
  ] as const)('does not truncate a %s preview a second time', async (target, makeMessages) => {
    const messages = makeMessages()
    const strategy = Offload.truncate(target, { previewTokens: 100 }).when({ blockThreshold: 101 })

    expect(await strategy.apply(makeContext(messages, 0))).toBe(true)
    const firstPass = [...textsOf(messages).flat(), ...resultTexts(messages)]
    const preview = firstPass.find((value) => value?.startsWith(TRUNCATED_PREFIX))!
    expect(Math.ceil(preview.length / 4)).toBeGreaterThan(101)

    expect(await strategy.apply(makeContext(messages, 0))).toBe(false)
    expect([...textsOf(messages).flat(), ...resultTexts(messages)]).toEqual(firstPass)
  })
})

describe('truncate per message (middle-out)', () => {
  /** Ten tokens per message under the heuristic. */
  const pad = (label: string): string => label.padEnd(40, '.')

  function history(): Message[] {
    const messages = [text('user', 'task')]
    for (let index = 1; index <= 10; index++) {
      messages.push(text(index % 2 === 1 ? 'assistant' : 'user', pad(`m${index}`)))
    }
    return messages
  }

  it.each([
    ['headTail', 40, ['task', 'm1', 'm2', '[... 7 messages elided ...]', 'm10']],
    ['head', 40, ['task', 'm1', 'm2', 'm3', 'm4', '[... 5 messages elided ...]', 'm10']],
    ['tail', 50, ['task', '[... 5 messages elided ...]', 'm6', 'm7', 'm8', 'm9', 'm10']],
  ] as [NonNullable<TruncateConfig['preview']>, number, string[]][])(
    'preview=%s with previewTokens=%s keeps the head and tail within budget',
    async (preview, previewTokens, expected) => {
      const messages = history()
      const strategy = Offload.truncate('*', { preview, previewTokens }).when({ utilization: 0.5 })

      expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)

      const label = (value: string): string => (value.startsWith('m') ? pad(value) : value)
      expect(textsOf(messages)).toEqual(expected.map((value) => [label(value)]))
    }
  )

  it('returns false when every eligible message fits the preview budget', async () => {
    const messages = history()
    const strategy = Offload.truncate('*', { previewTokens: 1000 }).when({ utilization: 0.5 })

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(false)
    expect(textsOf(messages)).toEqual(textsOf(history()))
  })
})

describe('summarize per message', () => {
  it('summarizes each contiguous run separately, around pinned messages', async () => {
    vi.mocked(summarizeContent).mockResolvedValueOnce('late run').mockResolvedValueOnce('early run')
    const messages = [
      text('user', 'task'),
      text('assistant', 'a1', true),
      text('user', 'u2'),
      text('assistant', 'a3'),
      text('user', 'u4'),
      text('assistant', 'a5', true),
      text('user', 'u6'),
      text('assistant', 'a7'),
      text('user', 'u8'),
      text('assistant', 'a9'),
      text('user', 'u10'),
    ]
    const strategy = Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)

    expect(summarizeContent).toHaveBeenCalledTimes(2)
    expect(textsOf(messages)).toEqual([
      ['task'],
      [
        'a1',
        '[Summarized: 3 messages, ~3 tokens]\n\nearly run',
        'a5',
        '[Summarized: 2 messages, ~2 tokens]\n\nlate run',
      ],
      ['u8'],
      ['a9'],
      ['u10'],
    ])
  })
})

describe('whole-message validation', () => {
  const BUILDERS: [string, () => { when(conditions: OffloadConditions): ContextStrategy }][] = [
    ['drop', () => Offload.drop('*')],
    ['truncate', () => Offload.truncate('*')],
    ['summarize', () => Offload.summarize('*')],
  ]

  describe.each(BUILDERS)('Offload.%s("*")', (method, builder) => {
    it.each([{}, { preserveRecent: 0 }, { preserveRecent: '0%' }] as OffloadConditions[])(
      'rejects %j',
      (conditions) => {
        expect(() => builder().when(conditions)).toThrow(
          `Offload.${method}("*") without blockThreshold acts on whole messages; set utilization or preserveRecent`
        )
      }
    )

    it.each([{ utilization: 0.5 }, { preserveRecent: 1 }, { blockThreshold: 2500 }] as OffloadConditions[])(
      'accepts %j',
      (conditions) => {
        expect(() => builder().when(conditions)).not.toThrow()
      }
    )
  })

  it('does not apply to strategies built without conditions', () => {
    expect(() => new EmergencyTruncateStrategy()).not.toThrow()
  })
})
