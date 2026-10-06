import { describe, expect, it } from 'vitest'
import { claimStorage, resolveNamespace, storageLocation } from '../storage.js'
import { InMemoryStorage } from '../in-memory-storage.js'
import { LocalFileStorage } from '../local-file-storage.js'
import { Agent } from '../../agent/agent.js'
import { SessionManager } from '../../session/session-manager.js'
import { ContextManager } from '../../context-manager/context-manager.js'

describe('resolveNamespace', () => {
  it('uses an explicit namespaced view as given', () => {
    const view = new InMemoryStorage().namespace('team')
    expect(resolveNamespace(view, 'context')).toBe(view)
  })

  it('prefixes an inherited namespaced view', async () => {
    const root = new InMemoryStorage()
    const resolved = resolveNamespace(root.namespace('tenant-a'), 'context', true)
    await resolved.write('k', new TextEncoder().encode('{}'))
    expect(await root.list('')).toEqual(['tenant-a/context/k'])
  })
})

describe('claimStorage', () => {
  it('rejects two subsystems on the same location', () => {
    const agent = {}
    const view = new InMemoryStorage().namespace('team')
    claimStorage(agent, {}, 'A', view)
    expect(() => claimStorage(agent, {}, 'B', view)).toThrow("B storage at 'team/' overlaps A storage at 'team/'")
  })

  it('rejects a claim nested under an exclusive root', () => {
    const agent = {}
    const root = new InMemoryStorage()
    claimStorage(agent, {}, 'stash', root.namespace('team'), true)
    expect(() => claimStorage(agent, {}, 'session', root.namespace('team/session'))).toThrow(/overlaps/)
  })

  it('allows a claim nested under a non-exclusive root', () => {
    const agent = {}
    const root = new InMemoryStorage()
    claimStorage(agent, {}, 'session', root.namespace('team'))
    expect(() => claimStorage(agent, {}, 'stash', root.namespace('team/context'), true)).not.toThrow()
  })

  it('allows sibling prefixes', () => {
    const agent = {}
    const root = new InMemoryStorage()
    claimStorage(agent, {}, 'stash', root.namespace('context'), true)
    expect(() => claimStorage(agent, {}, 'session', root.namespace('session'))).not.toThrow()
  })

  it('lets different agents share a view', () => {
    const view = new InMemoryStorage().namespace('team')
    claimStorage({}, {}, 'stash', view, true)
    expect(() => claimStorage({}, {}, 'stash', view, true)).not.toThrow()
  })

  it('replaces a claim re-made by the same owner', () => {
    const agent = {}
    const owner = {}
    const view = new InMemoryStorage().namespace('team')
    claimStorage(agent, owner, 'stash', view, true)
    expect(() => claimStorage(agent, owner, 'stash', view, true)).not.toThrow()
  })

  it('treats file storages on the same directory as the same location', () => {
    const agent = {}
    claimStorage(agent, {}, 'A', new LocalFileStorage('/tmp/strands-claims').namespace('x'))
    expect(() => claimStorage(agent, {}, 'B', new LocalFileStorage('/tmp/strands-claims').namespace('x'))).toThrow(
      /overlaps/
    )
  })
})

describe('agent wiring', () => {
  it('prefixes a namespaced agent storage per subsystem', async () => {
    const contextManager = new ContextManager()
    const agent = new Agent({
      model: {} as never,
      storage: new InMemoryStorage().namespace('tenant-a'),
      contextManager,
      sessionManager: new SessionManager({ sessionId: 's1' }),
      printer: false,
    })
    await agent.initialize()

    expect(storageLocation(contextManager.stash!.root).path).toBe('tenant-a/context/')
  })

  it('throws when a stash view encloses the session storage', async () => {
    const view = new InMemoryStorage().namespace('team')
    const agent = new Agent({
      model: {} as never,
      storage: view,
      contextManager: new ContextManager({ stash: { storage: view } }),
      sessionManager: new SessionManager({ sessionId: 's1' }),
      printer: false,
    })
    await expect(agent.initialize()).rejects.toThrow(/overlaps/)
  })
})
