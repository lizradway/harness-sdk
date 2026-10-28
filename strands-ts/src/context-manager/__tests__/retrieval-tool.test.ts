import { describe, it, expect } from 'vitest'
import { createRetrievalTool, RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { Stash } from '../stash.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { ImageBlock } from '../../types/media.js'

function invoke(retrievalTool: ReturnType<typeof createRetrievalTool>, input: unknown): Promise<unknown> {
  return (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke(input)
}

function encodeJSON(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

describe('retrieval tool', () => {
  function makeStashWithTextBlock(text: string): { stash: Stash; refPromise: Promise<string> } {
    const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
    const refPromise = stash.store('tool-1', 0, encodeJSON({ text }))
    return { stash, refPromise }
  }

  it('has the correct tool name', () => {
    const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
    const retrievalTool = createRetrievalTool(stash)
    expect(retrievalTool.name).toBe(RETRIEVAL_TOOL_NAME)
  })

  it('retrieves full text content', async () => {
    const { stash, refPromise } = makeStashWithTextBlock('hello world\nline two')
    const ref = await refPromise
    const retrievalTool = createRetrievalTool(stash)

    const result = await invoke(retrievalTool, { reference: ref })
    expect(result).toEqual({ text: 'hello world\nline two' })
  })

  it('searches with pattern', async () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `line ${index + 1}: ${index % 3 === 0 ? 'ERROR' : 'ok'}`
    ).join('\n')
    const { stash, refPromise } = makeStashWithTextBlock(text)
    const ref = await refPromise
    const retrievalTool = createRetrievalTool(stash)

    const result = (await invoke(retrievalTool, { reference: ref, pattern: 'ERROR' })) as string
    expect(result).toContain('ERROR')
    expect(result).toContain('match')
  })

  it('returns line range', async () => {
    const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n')
    const { stash, refPromise } = makeStashWithTextBlock(text)
    const ref = await refPromise
    const retrievalTool = createRetrievalTool(stash)

    const result = (await invoke(retrievalTool, { reference: ref, line_range: { start: 5, end: 10 } })) as string
    expect(result).toContain('line 5')
    expect(result).toContain('line 10')
    expect(result).not.toContain('line 11')
  })

  it('returns error for unknown reference', async () => {
    const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
    const retrievalTool = createRetrievalTool(stash)

    const result = (await invoke(retrievalTool, { reference: 'nonexistent' })) as string
    expect(result).toContain('Error: reference not found')
  })

  describe('a tool result referenced by its toolUseId', () => {
    async function makeStashWithItems(): Promise<Stash> {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      await stash.store('tool-1', 2, encodeJSON({ text: 'third ERROR' }))
      await stash.store('tool-1', 0, encodeJSON({ text: 'first' }))
      await stash.store('tool-1', 1, encodeJSON({ json: { count: 2 } }))
      await stash.store('tool-10', 0, encodeJSON({ text: 'another tool' }))
      return stash
    }

    it('returns every stored item in index order', async () => {
      const retrievalTool = createRetrievalTool(await makeStashWithItems())

      const result = await invoke(retrievalTool, { reference: 'tool-1' })

      expect(result).toEqual([{ text: 'first' }, { json: { count: 2 } }, { text: 'third ERROR' }])
    })

    it('searches across the items text', async () => {
      const retrievalTool = createRetrievalTool(await makeStashWithItems())

      const result = (await invoke(retrievalTool, { reference: 'tool-1', pattern: 'ERROR' })) as string

      expect(result).toContain('third ERROR')
      expect(result).not.toContain('another tool')
    })

    it('returns the single item itself when the result holds one', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      await stash.store('tool-1', 0, encodeJSON({ text: 'only' }))
      const retrievalTool = createRetrievalTool(stash)

      expect(await invoke(retrievalTool, { reference: 'tool-1' })).toEqual({ text: 'only' })
    })

    it('matches the id exactly when ids contain underscores and digits', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      await stash.store('call', 0, encodeJSON({ text: 'bare' }))
      await stash.store('call_12', 0, encodeJSON({ text: 'twelve' }))
      const retrievalTool = createRetrievalTool(stash)

      expect(await invoke(retrievalTool, { reference: 'call' })).toEqual({ text: 'bare' })
      expect(await invoke(retrievalTool, { reference: 'call_12' })).toEqual({ text: 'twelve' })
    })
  })

  describe('removed messages', () => {
    const removed = [
      { role: 'user', content: [{ text: 'alpha' }], trackingId: 'r0' },
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't', name: 'x', input: {} } }],
        trackingId: 'r1',
      },
      {
        role: 'user',
        content: [
          { toolResult: { toolUseId: 't', status: 'success', content: [{ text: 'beta ERROR' }, { json: 1 }] } },
        ],
        trackingId: 'r2',
      },
    ]

    it('returns the stored messages and searches their text and tool-result text', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      await stash.store('removed-m1', 0, encodeJSON(removed))
      const retrievalTool = createRetrievalTool(stash)

      expect(await invoke(retrievalTool, { reference: 'removed-m1' })).toEqual(removed)
      const matches = (await invoke(retrievalTool, { reference: 'removed-m1', pattern: 'ERROR' })) as string
      expect(matches).toContain('[1 match for /ERROR/]')
      expect(matches).toContain('> 2| beta ERROR')
    })
  })

  it.each([{}, { pattern: 'row-4321' }])('returns error for an offload placeholder with input %j', async (extra) => {
    const { stash, refPromise } = makeStashWithTextBlock(
      '[Truncated: 1 block, ~10,973 tokens]\n\nrow-1\n\n[Stashed] [ref: tool-1_0]'
    )
    const ref = await refPromise
    const retrievalTool = createRetrievalTool(stash)

    const result = await invoke(retrievalTool, { reference: ref, ...extra })
    expect(result).toBe(`Error: original content for reference ${ref} is no longer available`)
  })

  it('restores image content as an ImageBlock instead of raw JSON', async () => {
    const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
    const imageData = { image: { format: 'png', source: { bytes: 'iVBORw0KGgo=' } } }
    const ref = await stash.store('tool-img', 0, encodeJSON(imageData))
    const retrievalTool = createRetrievalTool(stash)

    const result = await invoke(retrievalTool, { reference: ref })
    expect(result).toBeInstanceOf(ImageBlock)
    expect((result as ImageBlock).format).toBe('png')
  })

  it('retrieves JSON content as parsed object', async () => {
    const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
    const json = { key: 'value', nested: [1, 2, 3] }
    const ref = await stash.store('tool-json', 0, encodeJSON({ json }))
    const retrievalTool = createRetrievalTool(stash)

    const result = await invoke(retrievalTool, { reference: ref })
    expect(result).toEqual({ json })
  })

  it('returns error when searching non-text content', async () => {
    const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
    const imageData = { image: { format: 'png', source: { bytes: 'iVBORw0KGgo=' } } }
    const ref = await stash.store('tool-img', 0, encodeJSON(imageData))
    const retrievalTool = createRetrievalTool(stash)

    const result = (await invoke(retrievalTool, { reference: ref, pattern: 'test' })) as string
    expect(result).toContain('cannot search non-text content')
  })
})
