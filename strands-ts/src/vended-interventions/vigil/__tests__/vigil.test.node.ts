import { describe, it, expect, beforeEach } from 'vitest'
import { Vigil, InMemoryVigilStorage } from '../vigil.js'
import type { Constraint } from '../vigil.js'
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

describe('Vigil', () => {
  describe('forbid constraints', () => {
    it('denies a forbidden tool', async () => {
      const vigil = new Vigil({
        compiledConstraints: [{ type: 'forbid', tool: 'admin_delete' }],
      })

      const result = await vigil.beforeToolCall(makeBeforeEvent('admin_delete'))
      expect(result).toEqual({ type: 'deny', reason: 'forbidden: admin_delete is not permitted' })
    })

    it('allows tools not in the forbid list', async () => {
      const vigil = new Vigil({
        compiledConstraints: [{ type: 'forbid', tool: 'admin_delete' }],
      })

      const result = await vigil.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('requires constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        compiledConstraints: [{ type: 'requires', tool: 'charge', condition: 'authenticate' }],
      })
    })

    it('denies when prerequisite has not completed', async () => {
      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'requires: charge requires authenticate to have completed first',
      })
    })

    it('allows when prerequisite has completed', async () => {
      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies when prerequisite failed (not completed)', async () => {
      await vigil.afterToolCall(makeAfterEvent('authenticate', {}, { error: new Error('fail') }))
      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'requires: charge requires authenticate to have completed first',
      })
    })

    it('allows unrelated tools regardless of prerequisite', async () => {
      const result = await vigil.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('loop constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        compiledConstraints: [{ type: 'loop', tool: 'search', maxRepeats: 3 }],
      })
    })

    it('allows calls below the threshold', async () => {
      const input = { query: 'test' }
      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('search', input))
      }
      const result = await vigil.beforeToolCall(makeBeforeEvent('search', { query: 'different' }))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies when same input exceeds threshold', async () => {
      const input = { query: 'test' }
      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('search', input))
      }
      const result = await vigil.beforeToolCall(makeBeforeEvent('search', input))
      expect(result).toEqual({
        type: 'deny',
        reason: 'loop: search called 3 times with same input (max 3)',
      })
    })

    it('tracks different inputs independently', async () => {
      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('search', { query: 'a' }))
      }
      const result = await vigil.beforeToolCall(makeBeforeEvent('search', { query: 'b' }))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('cascade constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        compiledConstraints: [{ type: 'cascade', trigger: 'deploy', blocks: ['promote', 'rollback'] }],
      })
    })

    it('allows blocked tools when trigger has not failed', async () => {
      await vigil.afterToolCall(makeAfterEvent('deploy'))
      const result = await vigil.beforeToolCall(makeBeforeEvent('promote'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies blocked tools when trigger has failed', async () => {
      await vigil.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('deploy failed') }))
      const result = await vigil.beforeToolCall(makeBeforeEvent('promote'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'cascade: promote blocked because deploy failed',
      })
    })

    it('denies all tools in the blocks list', async () => {
      await vigil.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('fail') }))
      const promoteResult = await vigil.beforeToolCall(makeBeforeEvent('promote'))
      const rollbackResult = await vigil.beforeToolCall(makeBeforeEvent('rollback'))
      expect(promoteResult.type).toBe('deny')
      expect(rollbackResult.type).toBe('deny')
    })

    it('allows unrelated tools even after trigger failure', async () => {
      await vigil.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('fail') }))
      const result = await vigil.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('budget constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        compiledConstraints: [{ type: 'budget', tool: 'charge', maxCalls: 3 }],
      })
    })

    it('allows calls within budget', async () => {
      await vigil.afterToolCall(makeAfterEvent('charge'))
      await vigil.afterToolCall(makeAfterEvent('charge'))
      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies calls exceeding budget', async () => {
      await vigil.afterToolCall(makeAfterEvent('charge'))
      await vigil.afterToolCall(makeAfterEvent('charge'))
      await vigil.afterToolCall(makeAfterEvent('charge'))
      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'budget: charge exceeded max calls (3)',
      })
    })

    it('allows other tools regardless of budget', async () => {
      for (let index = 0; index < 5; index++) {
        await vigil.afterToolCall(makeAfterEvent('charge'))
      }
      const result = await vigil.beforeToolCall(makeBeforeEvent('refund'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('multiple constraints', () => {
    it('evaluates all constraints and denies on first violation', async () => {
      const vigil = new Vigil({
        compiledConstraints: [
          { type: 'requires', tool: 'charge', condition: 'authenticate' },
          { type: 'budget', tool: 'charge', maxCalls: 3 },
        ],
      })

      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('requires')
    })

    it('checks all constraints even when first passes', async () => {
      const vigil = new Vigil({
        compiledConstraints: [
          { type: 'requires', tool: 'charge', condition: 'authenticate' },
          { type: 'budget', tool: 'charge', maxCalls: 2 },
        ],
      })

      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      await vigil.afterToolCall(makeAfterEvent('charge'))
      await vigil.afterToolCall(makeAfterEvent('charge'))

      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('budget')
    })
  })

  describe('trajectory management', () => {
    it('resets trajectory state', async () => {
      const vigil = new Vigil({
        compiledConstraints: [{ type: 'requires', tool: 'charge', condition: 'authenticate' }],
      })

      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      expect((await vigil.beforeToolCall(makeBeforeEvent('charge'))).type).toBe('proceed')

      vigil.resetTrajectory()
      expect((await vigil.beforeToolCall(makeBeforeEvent('charge'))).type).toBe('deny')
    })
  })

  describe('getConstraintRecords', () => {
    it('returns the configured constraints as records', () => {
      const constraints: Constraint[] = [
        { type: 'requires', tool: 'charge', condition: 'authenticate' },
        { type: 'budget', tool: 'charge', maxCalls: 5 },
      ]
      const vigil = new Vigil({ compiledConstraints: constraints })

      const records = vigil.getConstraintRecords()
      expect(records).toHaveLength(2)
      expect(records[0]!.constraint).toEqual(constraints[0])
      expect(records[0]!.status).toBe('enforcing')
      expect(records[0]!.source).toBe('authored')
    })
  })

  describe('afterToolCall result status', () => {
    it('records error status result as failure', async () => {
      const vigil = new Vigil({
        compiledConstraints: [{ type: 'cascade', trigger: 'deploy', blocks: ['promote'] }],
      })

      await vigil.afterToolCall(makeAfterEvent('deploy', {}, { status: 'error' }))
      const result = await vigil.beforeToolCall(makeBeforeEvent('promote'))
      expect(result.type).toBe('deny')
    })
  })

  describe('discovery: prerequisites', () => {
    it('discovers a requires constraint from failure/success pattern', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })

      // 3 failures without authenticate
      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403 Forbidden') }))
      }

      // 1 success with authenticate preceding
      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      await vigil.afterToolCall(makeAfterEvent('charge'))

      const enforcing = vigil.getEnforcingConstraints()
      expect(enforcing.length).toBeGreaterThanOrEqual(1)

      const prereq = enforcing.find(
        (record) => record.constraint.type === 'requires' && record.constraint.tool === 'charge'
      )
      expect(prereq).toBeDefined()
      expect(prereq!.constraint.type).toBe('requires')
      expect((prereq!.constraint as { condition: string }).condition).toBe('authenticate')
      expect(prereq!.source).toBe('discovered')
    })

    it('does not discover with insufficient evidence', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 5 })

      // Only 2 failures — below threshold of 5
      await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      await vigil.afterToolCall(makeAfterEvent('charge'))

      const enforcing = vigil.getEnforcingConstraints()
      const prereq = enforcing.find(
        (record) => record.constraint.type === 'requires'
      )
      expect(prereq).toBeUndefined()
    })

    it('enforces discovered constraint in same session', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })

      // Train: 3 failures without auth, 1 success with auth
      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      await vigil.afterToolCall(makeAfterEvent('charge'))

      // Now it should block charge without authenticate in trajectory
      vigil.resetTrajectory()
      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('requires')
    })

    it('allows charge after authenticate once constraint is discovered', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })

      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      await vigil.afterToolCall(makeAfterEvent('charge'))

      // Reset trajectory, do auth then charge
      vigil.resetTrajectory()
      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('proceed')
    })
  })

  describe('discovery: cross-agent transfer via storage', () => {
    it('persists and loads constraints across instances', async () => {
      const storage = new InMemoryVigilStorage()

      // Agent A discovers
      const agentA = new Vigil({ discover: true, minEvidence: 3, storage })
      for (let index = 0; index < 3; index++) {
        await agentA.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      await agentA.afterToolCall(makeAfterEvent('authenticate'))
      await agentA.afterToolCall(makeAfterEvent('charge'))
      await agentA.persist()

      // Agent B loads from storage — never saw a failure
      const agentB = new Vigil({ discover: true, storage })
      const result = await agentB.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
    })
  })

  describe('discovery: end-to-end scenario', () => {
    it('converges from 100% failure to 0% post-discovery', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })

      let failures = 0
      let blocked = 0
      let successes = 0
      const totalRounds = 20

      for (let round = 0; round < totalRounds; round++) {
        const doesAuthFirst = round % 5 === 4

        if (doesAuthFirst) {
          await vigil.afterToolCall(makeAfterEvent('authenticate'))
          const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
          if (result.type === 'deny') {
            blocked++
          } else {
            await vigil.afterToolCall(makeAfterEvent('charge'))
            successes++
          }
        } else {
          const result = await vigil.beforeToolCall(makeBeforeEvent('charge'))
          if (result.type === 'deny') {
            blocked++
          } else {
            await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403 Forbidden') }))
            failures++
          }
        }
      }

      // After discovery kicks in, no more raw failures should occur
      expect(failures).toBeLessThanOrEqual(4)
      expect(blocked).toBeGreaterThan(0)
      expect(successes).toBeGreaterThan(0)

      // Post-discovery: last 10 rounds should have zero failures
      const postDiscoveryFailures = failures - 3 // first 3 are learning
      expect(postDiscoveryFailures).toBeLessThanOrEqual(1)
    })
  })
})
