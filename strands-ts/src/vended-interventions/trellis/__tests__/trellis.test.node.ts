import { describe, it, expect, beforeEach } from 'vitest'
import { Trellis, InMemoryTrellisStorage } from '../trellis.js'
import type { Constraint } from '../trellis.js'
import { BeforeToolCallEvent, AfterToolCallEvent } from '../../../hooks/events.js'

function makeBeforeEvent(toolName: string, input: unknown = {}): BeforeToolCallEvent {
  return {
    type: 'beforeToolCallEvent',
    agent: { appState: { get: () => undefined, set: () => {} } },
    toolUse: { name: toolName, toolUseId: `id-${toolName}`, input },
    tool: undefined,
    invocationState: {},
    cancel: false,
    selectedTool: undefined,
    interrupt: () => { throw new Error('not implemented') },
  } as unknown as BeforeToolCallEvent
}

function makeAfterEvent(
  toolName: string,
  input: unknown = {},
  options: { error?: Error; status?: 'success' | 'error' } = {}
): AfterToolCallEvent {
  return {
    type: 'afterToolCallEvent',
    agent: { appState: { get: () => undefined, set: () => {} } },
    toolUse: { name: toolName, toolUseId: `id-${toolName}`, input },
    tool: undefined,
    result: { toolUseId: `id-${toolName}`, status: options.status ?? 'success', content: [] },
    invocationState: {},
    error: options.error,
  } as unknown as AfterToolCallEvent
}

describe('Trellis', () => {
  describe('forbid constraints', () => {
    it('denies a forbidden tool', async () => {
      const trellis = new Trellis({
        compiledConstraints: [{ type: 'forbid', tool: 'admin_delete' }],
      })

      const result = await trellis.beforeToolCall(makeBeforeEvent('admin_delete'))
      expect(result).toEqual({ type: 'deny', reason: 'forbidden: admin_delete is not permitted' })
    })

    it('allows tools not in the forbid list', async () => {
      const trellis = new Trellis({
        compiledConstraints: [{ type: 'forbid', tool: 'admin_delete' }],
      })

      const result = await trellis.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('requires constraints', () => {
    let trellis: Trellis

    beforeEach(() => {
      trellis = new Trellis({
        compiledConstraints: [{ type: 'requires', tool: 'charge', condition: 'authenticate' }],
      })
    })

    it('denies when prerequisite has not completed', async () => {
      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'requires: charge requires authenticate to have completed first',
      })
    })

    it('allows when prerequisite has completed', async () => {
      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies when prerequisite failed (not completed)', async () => {
      await trellis.afterToolCall(makeAfterEvent('authenticate', {}, { error: new Error('fail') }))
      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'requires: charge requires authenticate to have completed first',
      })
    })

    it('allows unrelated tools regardless of prerequisite', async () => {
      const result = await trellis.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('loop constraints', () => {
    let trellis: Trellis

    beforeEach(() => {
      trellis = new Trellis({
        compiledConstraints: [{ type: 'loop', tool: 'search', maxRepeats: 3 }],
      })
    })

    it('allows calls below the threshold', async () => {
      const input = { query: 'test' }
      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('search', input))
      }
      const result = await trellis.beforeToolCall(makeBeforeEvent('search', { query: 'different' }))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies when same input exceeds threshold', async () => {
      const input = { query: 'test' }
      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('search', input))
      }
      const result = await trellis.beforeToolCall(makeBeforeEvent('search', input))
      expect(result).toEqual({
        type: 'deny',
        reason: 'loop: search called 3 times with same input (max 3)',
      })
    })

    it('tracks different inputs independently', async () => {
      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('search', { query: 'a' }))
      }
      const result = await trellis.beforeToolCall(makeBeforeEvent('search', { query: 'b' }))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('cascade constraints', () => {
    let trellis: Trellis

    beforeEach(() => {
      trellis = new Trellis({
        compiledConstraints: [{ type: 'cascade', trigger: 'deploy', blocks: ['promote', 'rollback'] }],
      })
    })

    it('allows blocked tools when trigger has not failed', async () => {
      await trellis.afterToolCall(makeAfterEvent('deploy'))
      const result = await trellis.beforeToolCall(makeBeforeEvent('promote'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies blocked tools when trigger has failed', async () => {
      await trellis.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('deploy failed') }))
      const result = await trellis.beforeToolCall(makeBeforeEvent('promote'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'cascade: promote blocked because deploy failed',
      })
    })

    it('denies all tools in the blocks list', async () => {
      await trellis.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('fail') }))
      const promoteResult = await trellis.beforeToolCall(makeBeforeEvent('promote'))
      const rollbackResult = await trellis.beforeToolCall(makeBeforeEvent('rollback'))
      expect(promoteResult.type).toBe('deny')
      expect(rollbackResult.type).toBe('deny')
    })

    it('allows unrelated tools even after trigger failure', async () => {
      await trellis.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('fail') }))
      const result = await trellis.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('budget constraints', () => {
    let trellis: Trellis

    beforeEach(() => {
      trellis = new Trellis({
        compiledConstraints: [{ type: 'budget', tool: 'charge', maxCalls: 3 }],
      })
    })

    it('allows calls within budget', async () => {
      await trellis.afterToolCall(makeAfterEvent('charge'))
      await trellis.afterToolCall(makeAfterEvent('charge'))
      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies calls exceeding budget', async () => {
      await trellis.afterToolCall(makeAfterEvent('charge'))
      await trellis.afterToolCall(makeAfterEvent('charge'))
      await trellis.afterToolCall(makeAfterEvent('charge'))
      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'budget: charge exceeded max calls (3)',
      })
    })

    it('allows other tools regardless of budget', async () => {
      for (let index = 0; index < 5; index++) {
        await trellis.afterToolCall(makeAfterEvent('charge'))
      }
      const result = await trellis.beforeToolCall(makeBeforeEvent('refund'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('multiple constraints', () => {
    it('evaluates all constraints and denies on first violation', async () => {
      const trellis = new Trellis({
        compiledConstraints: [
          { type: 'requires', tool: 'charge', condition: 'authenticate' },
          { type: 'budget', tool: 'charge', maxCalls: 3 },
        ],
      })

      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('requires')
    })

    it('checks all constraints even when first passes', async () => {
      const trellis = new Trellis({
        compiledConstraints: [
          { type: 'requires', tool: 'charge', condition: 'authenticate' },
          { type: 'budget', tool: 'charge', maxCalls: 2 },
        ],
      })

      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      await trellis.afterToolCall(makeAfterEvent('charge'))
      await trellis.afterToolCall(makeAfterEvent('charge'))

      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('budget')
    })
  })

  describe('trajectory management', () => {
    it('resets trajectory state', async () => {
      const trellis = new Trellis({
        compiledConstraints: [{ type: 'requires', tool: 'charge', condition: 'authenticate' }],
      })

      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      expect((await trellis.beforeToolCall(makeBeforeEvent('charge'))).type).toBe('proceed')

      trellis.resetTrajectory()
      expect((await trellis.beforeToolCall(makeBeforeEvent('charge'))).type).toBe('deny')
    })
  })

  describe('getConstraintRecords', () => {
    it('returns the configured constraints as records', () => {
      const constraints: Constraint[] = [
        { type: 'requires', tool: 'charge', condition: 'authenticate' },
        { type: 'budget', tool: 'charge', maxCalls: 5 },
      ]
      const trellis = new Trellis({ compiledConstraints: constraints })

      const records = trellis.getConstraintRecords()
      expect(records).toHaveLength(2)
      expect(records[0]!.constraint).toEqual(constraints[0])
      expect(records[0]!.status).toBe('enforcing')
      expect(records[0]!.source).toBe('authored')
    })
  })

  describe('afterToolCall result status', () => {
    it('records error status result as failure', async () => {
      const trellis = new Trellis({
        compiledConstraints: [{ type: 'cascade', trigger: 'deploy', blocks: ['promote'] }],
      })

      await trellis.afterToolCall(makeAfterEvent('deploy', {}, { status: 'error' }))
      const result = await trellis.beforeToolCall(makeBeforeEvent('promote'))
      expect(result.type).toBe('deny')
    })
  })

  describe('mining: prerequisites', () => {
    it('mines a requires constraint from failure/success pattern', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })

      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403 Forbidden') }))
      }

      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      await trellis.afterToolCall(makeAfterEvent('charge'))

      const enforcing = trellis.getEnforcingConstraints()
      expect(enforcing.length).toBeGreaterThanOrEqual(1)

      const prereq = enforcing.find(
        (record) => record.constraint.type === 'requires' && record.constraint.tool === 'charge'
      )
      expect(prereq).toBeDefined()
      expect(prereq!.constraint.type).toBe('requires')
      expect((prereq!.constraint as { condition: string }).condition).toBe('authenticate')
      expect(prereq!.source).toBe('discovered')
    })

    it('does not mine with insufficient evidence', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 5 })

      await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      await trellis.afterToolCall(makeAfterEvent('charge'))

      const enforcing = trellis.getEnforcingConstraints()
      const prereq = enforcing.find(
        (record) => record.constraint.type === 'requires'
      )
      expect(prereq).toBeUndefined()
    })

    it('enforces mined constraint in same session', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })

      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      await trellis.afterToolCall(makeAfterEvent('charge'))

      trellis.resetTrajectory()
      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('requires')
    })

    it('allows charge after authenticate once constraint is mined', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })

      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      await trellis.afterToolCall(makeAfterEvent('charge'))

      trellis.resetTrajectory()
      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('proceed')
    })
  })

  describe('mining: cross-agent transfer via storage', () => {
    it('persists and loads constraints across instances', async () => {
      const storage = new InMemoryTrellisStorage()

      const agentA = new Trellis({ discover: true, minEvidence: 3, storage })
      for (let index = 0; index < 3; index++) {
        await agentA.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      await agentA.afterToolCall(makeAfterEvent('authenticate'))
      await agentA.afterToolCall(makeAfterEvent('charge'))
      await agentA.persist()

      const agentB = new Trellis({ discover: true, storage })
      const result = await agentB.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
    })
  })

  describe('mining: end-to-end scenario', () => {
    it('converges from 100% failure to 0% post-mining', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })

      let failures = 0
      let blocked = 0
      let successes = 0
      const totalRounds = 20

      for (let round = 0; round < totalRounds; round++) {
        const doesAuthFirst = round % 5 === 4

        if (doesAuthFirst) {
          await trellis.afterToolCall(makeAfterEvent('authenticate'))
          const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
          if (result.type === 'deny') {
            blocked++
          } else {
            await trellis.afterToolCall(makeAfterEvent('charge'))
            successes++
          }
        } else {
          const result = await trellis.beforeToolCall(makeBeforeEvent('charge'))
          if (result.type === 'deny') {
            blocked++
          } else {
            await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403 Forbidden') }))
            failures++
          }
        }
      }

      expect(failures).toBeLessThanOrEqual(4)
      expect(blocked).toBeGreaterThan(0)
      expect(successes).toBeGreaterThan(0)

      const postDiscoveryFailures = failures - 3
      expect(postDiscoveryFailures).toBeLessThanOrEqual(1)
    })
  })
})
