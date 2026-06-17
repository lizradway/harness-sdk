import { describe, it, expect } from 'vitest'
import { Transcript } from '../transcript.js'
import { InMemoryStorage } from '../../vended-plugins/context-offloader/storage.js'
import { Message, TextBlock } from '../../types/messages.js'

function userText(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

describe('Transcript', () => {
  it('appends messages and returns them most-recent-first via getRecent', async () => {
    const transcript = new Transcript({ scratchpad: new InMemoryStorage() })
    await transcript.append([userText('first'), userText('second')])
    const recent = await transcript.getRecent(2)
    expect(recent).toHaveLength(2)
    expect((recent[1]!.content[0] as TextBlock).text).toBe('second')
  })

  it('searches by keyword, most recent first', async () => {
    const transcript = new Transcript({ scratchpad: new InMemoryStorage() })
    await transcript.append([userText('the quick brown fox'), userText('lazy dog'), userText('quick fix')])
    const results = await transcript.search('quick')
    expect(results).toHaveLength(2)
    expect((results[0]!.content[0] as TextBlock).text).toBe('quick fix')
  })

  it('evicts oldest entries when over maxSize with oldest-first policy', async () => {
    const transcript = new Transcript({ scratchpad: new InMemoryStorage(), maxSize: 200, eviction: 'oldest-first' })
    for (let i = 0; i < 20; i++) {
      await transcript.append([userText(`message number ${i} with some padding text`)])
    }
    expect(transcript.byteSize).toBeLessThanOrEqual(200)
    expect(transcript.size).toBeLessThan(20)
  })

  it('does not evict unextracted entries under after-extraction policy', async () => {
    const transcript = new Transcript({ scratchpad: new InMemoryStorage(), maxSize: 100, eviction: 'after-extraction' })
    for (let i = 0; i < 10; i++) {
      await transcript.append([userText(`padding message ${i} text text text`)])
    }
    // Nothing extracted yet → nothing evicted despite exceeding maxSize.
    expect(transcript.size).toBe(10)
    transcript.markExtracted(5)
    await transcript.append([userText('trigger eviction pass with more padding text here')])
    expect(transcript.size).toBeLessThan(11)
  })

  it('parses string maxSize like "1KB"', async () => {
    const transcript = new Transcript({ scratchpad: new InMemoryStorage(), maxSize: '1KB', eviction: 'never' })
    await transcript.append([userText('x'.repeat(2000))])
    // "never" policy means no eviction regardless of size.
    expect(transcript.size).toBe(1)
  })

  it('exposes get_history and search_history retrieval tools', () => {
    const transcript = new Transcript({ scratchpad: new InMemoryStorage() })
    const tools = transcript.retrievalTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['get_history', 'search_history'])
  })
})
