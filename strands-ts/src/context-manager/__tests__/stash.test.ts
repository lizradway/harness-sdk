import { describe, it, expect } from 'vitest'
import { Stash } from '../stash.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { namespace } from '../../storage/storage.js'

describe('Stash', () => {
  describe('store and retrieve', () => {
    it('round-trips text content', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const data = { type: 'text', text: 'hello world' }
      const ref = await stash.store('tool-123', 0, new TextEncoder().encode(JSON.stringify(data)))

      expect(ref).toContain('tool-123')

      const result = await stash.retrieve(ref)
      expect(result).not.toBeNull()
      expect(result!.data).toEqual(data)
    })

    it('round-trips JSON content', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const data = { key: 'value', count: 42 }
      const ref = await stash.store('tool-456', 1, new TextEncoder().encode(JSON.stringify(data)))

      const result = await stash.retrieve(ref)
      expect(result).not.toBeNull()
      expect(result!.data).toEqual(data)
    })

    it('returns null for unknown references', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const result = await stash.retrieve('nonexistent')
      expect(result).toBeNull()
    })

    it('produces deterministic keys from the same id and blockIndex', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref1 = await stash.store('tool-1', 0, content)
      const ref2 = await stash.store('tool-1', 0, content)

      expect(ref1).toBe(ref2)
    })

    it('produces different keys for different id or blockIndex', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref1 = await stash.store('tool-1', 0, content)
      const ref2 = await stash.store('tool-1', 1, content)
      const ref3 = await stash.store('tool-2', 0, content)

      expect(ref1).not.toBe(ref2)
      expect(ref1).not.toBe(ref3)
    })
  })

  describe('list', () => {
    it('lists all stored references', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref1 = await stash.store('tool-a', 0, content)
      const ref2 = await stash.store('tool-b', 0, content)

      const keys = await stash.list()
      expect(keys).toContain(ref1)
      expect(keys).toContain(ref2)
    })
  })

  describe('delete', () => {
    it('removes a stashed entry', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref = await stash.store('tool-x', 0, content)

      await stash.delete(ref)
      const result = await stash.retrieve(ref)
      expect(result).toBeNull()
    })
  })

  describe('namespacing', () => {
    it('does not conflict with other storage users', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage, 'test-session', 'test-agent')

      const content = new TextEncoder().encode(JSON.stringify('stash data'))
      await stash.store('tool-1', 0, content)

      await storage.write('other-key', new TextEncoder().encode('other'))

      const topKeys = await storage.list('')
      expect(topKeys.some((key) => key.startsWith('context/'))).toBe(true)
      expect(topKeys).toContain('other-key')
    })

    it('uses a caller-scoped view as the stash root verbatim', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(namespace(storage, 'tenants/t1/context'), 'sess-1', 'agent-1')

      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('scoped')))

      expect(await storage.list('')).toEqual(['tenants/t1/context/tool-1_0'])
    })

    it('lets agents sharing a view read each others entries', async () => {
      const storage = new InMemoryStorage()
      const orchestrator = new Stash(namespace(storage, 'team'), 'sess-1', 'agent-a')
      const subagent = new Stash(namespace(storage, 'team'), 'sess-1', 'agent-b')

      await orchestrator.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('shared')))

      expect(await subagent.retrieve('tool-1_0')).toEqual({ data: 'shared' })
    })

    it('keeps agents isolated when the view carries the agent id', async () => {
      const storage = new InMemoryStorage()
      const stashA = new Stash(namespace(storage, 'team/agent-a'), 'sess-1', 'agent-a')
      const stashB = new Stash(namespace(storage, 'team/agent-b'), 'sess-1', 'agent-b')

      await stashA.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('a')))

      expect(await stashB.retrieve('tool-1_0')).toBeNull()
    })

    it('keeps sessions isolated when the view carries the session id', async () => {
      const storage = new InMemoryStorage()
      const stashS1 = new Stash(namespace(storage, 'team/sess-1'), 'sess-1', 'agent-a')
      const stashS2 = new Stash(namespace(storage, 'team/sess-2'), 'sess-2', 'agent-a')

      await stashS1.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('s1')))

      expect(await stashS2.retrieve('tool-1_0')).toBeNull()
    })
  })

  describe('clearSession', () => {
    it('deletes entries across agents in the session', async () => {
      const storage = new InMemoryStorage()
      const stashA = new Stash(storage, 'sess-1', 'agent-a')
      const stashB = new Stash(storage, 'sess-1', 'agent-b')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      await stashA.store('tool-1', 0, content)
      await stashB.store('tool-1', 0, content)

      await stashA.clearSession()

      expect(await stashA.list()).toEqual([])
      expect(await stashB.list()).toEqual([])
    })

    it('leaves a caller-supplied view untouched', async () => {
      const storage = new InMemoryStorage()
      const orchestrator = new Stash(namespace(storage, 'team'), 'sess-1', 'agent-a')
      const subagent = new Stash(namespace(storage, 'team'), 'sess-2', 'agent-b')
      await orchestrator.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('own')))
      await subagent.store('tool-9', 0, new TextEncoder().encode(JSON.stringify('peer')))
      await storage.write('team/caller-owned', new TextEncoder().encode('{}'))

      await orchestrator.clearSession()

      expect((await storage.list('')).sort()).toEqual(['team/caller-owned', 'team/tool-1_0', 'team/tool-9_0'])
    })
  })
})
