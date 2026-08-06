import { describe, it, expect, beforeEach } from 'vitest'
import { Vigil } from '../vigil.js'
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
    it('denies a forbidden tool', () => {
      const vigil = new Vigil({
        constraints: [{ type: 'forbid', tool: 'admin_delete' }],
      })

      const result = vigil.beforeToolCall(makeBeforeEvent('admin_delete'))
      expect(result).toEqual({ type: 'deny', reason: 'forbidden: admin_delete is not permitted' })
    })

    it('allows tools not in the forbid list', () => {
      const vigil = new Vigil({
        constraints: [{ type: 'forbid', tool: 'admin_delete' }],
      })

      const result = vigil.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('requires constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        constraints: [{ type: 'requires', tool: 'charge', condition: 'authenticate' }],
      })
    })

    it('denies when prerequisite has not completed', () => {
      const result = vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'requires: charge requires authenticate to have completed first',
      })
    })

    it('allows when prerequisite has completed', () => {
      vigil.afterToolCall(makeAfterEvent('authenticate'))
      const result = vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies when prerequisite failed (not completed)', () => {
      vigil.afterToolCall(makeAfterEvent('authenticate', {}, { error: new Error('fail') }))
      const result = vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'requires: charge requires authenticate to have completed first',
      })
    })

    it('allows unrelated tools regardless of prerequisite', () => {
      const result = vigil.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('loop constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        constraints: [{ type: 'loop', tool: 'search', maxRepeats: 3 }],
      })
    })

    it('allows calls below the threshold', () => {
      const input = { query: 'test' }
      for (let index = 0; index < 3; index++) {
        vigil.afterToolCall(makeAfterEvent('search', input))
      }
      const result = vigil.beforeToolCall(makeBeforeEvent('search', { query: 'different' }))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies when same input exceeds threshold', () => {
      const input = { query: 'test' }
      for (let index = 0; index < 3; index++) {
        vigil.afterToolCall(makeAfterEvent('search', input))
      }
      const result = vigil.beforeToolCall(makeBeforeEvent('search', input))
      expect(result).toEqual({
        type: 'deny',
        reason: 'loop: search called 3 times with same input (max 3)',
      })
    })

    it('tracks different inputs independently', () => {
      for (let index = 0; index < 3; index++) {
        vigil.afterToolCall(makeAfterEvent('search', { query: 'a' }))
      }
      const result = vigil.beforeToolCall(makeBeforeEvent('search', { query: 'b' }))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('cascade constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        constraints: [{ type: 'cascade', trigger: 'deploy', blocks: ['promote', 'rollback'] }],
      })
    })

    it('allows blocked tools when trigger has not failed', () => {
      vigil.afterToolCall(makeAfterEvent('deploy'))
      const result = vigil.beforeToolCall(makeBeforeEvent('promote'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies blocked tools when trigger has failed', () => {
      vigil.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('deploy failed') }))
      const result = vigil.beforeToolCall(makeBeforeEvent('promote'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'cascade: promote blocked because deploy failed',
      })
    })

    it('denies all tools in the blocks list', () => {
      vigil.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('fail') }))
      const promoteResult = vigil.beforeToolCall(makeBeforeEvent('promote'))
      const rollbackResult = vigil.beforeToolCall(makeBeforeEvent('rollback'))
      expect(promoteResult.type).toBe('deny')
      expect(rollbackResult.type).toBe('deny')
    })

    it('allows unrelated tools even after trigger failure', () => {
      vigil.afterToolCall(makeAfterEvent('deploy', {}, { error: new Error('fail') }))
      const result = vigil.beforeToolCall(makeBeforeEvent('search'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('budget constraints', () => {
    let vigil: Vigil

    beforeEach(() => {
      vigil = new Vigil({
        constraints: [{ type: 'budget', tool: 'charge', maxCalls: 3 }],
      })
    })

    it('allows calls within budget', () => {
      vigil.afterToolCall(makeAfterEvent('charge'))
      vigil.afterToolCall(makeAfterEvent('charge'))
      const result = vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({ type: 'proceed' })
    })

    it('denies calls exceeding budget', () => {
      vigil.afterToolCall(makeAfterEvent('charge'))
      vigil.afterToolCall(makeAfterEvent('charge'))
      vigil.afterToolCall(makeAfterEvent('charge'))
      const result = vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result).toEqual({
        type: 'deny',
        reason: 'budget: charge exceeded max calls (3)',
      })
    })

    it('allows other tools regardless of budget', () => {
      for (let index = 0; index < 5; index++) {
        vigil.afterToolCall(makeAfterEvent('charge'))
      }
      const result = vigil.beforeToolCall(makeBeforeEvent('refund'))
      expect(result).toEqual({ type: 'proceed' })
    })
  })

  describe('multiple constraints', () => {
    it('evaluates all constraints and denies on first violation', () => {
      const vigil = new Vigil({
        constraints: [
          { type: 'requires', tool: 'charge', condition: 'authenticate' },
          { type: 'budget', tool: 'charge', maxCalls: 3 },
        ],
      })

      const result = vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('requires')
    })

    it('checks all constraints even when first passes', () => {
      const vigil = new Vigil({
        constraints: [
          { type: 'requires', tool: 'charge', condition: 'authenticate' },
          { type: 'budget', tool: 'charge', maxCalls: 2 },
        ],
      })

      vigil.afterToolCall(makeAfterEvent('authenticate'))
      vigil.afterToolCall(makeAfterEvent('charge'))
      vigil.afterToolCall(makeAfterEvent('charge'))

      const result = vigil.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('deny')
      expect((result as { reason: string }).reason).toContain('budget')
    })
  })

  describe('trajectory management', () => {
    it('resets trajectory state', () => {
      const vigil = new Vigil({
        constraints: [{ type: 'requires', tool: 'charge', condition: 'authenticate' }],
      })

      vigil.afterToolCall(makeAfterEvent('authenticate'))
      expect(vigil.beforeToolCall(makeBeforeEvent('charge')).type).toBe('proceed')

      vigil.resetTrajectory()
      expect(vigil.beforeToolCall(makeBeforeEvent('charge')).type).toBe('deny')
    })
  })

  describe('getConstraints', () => {
    it('returns the configured constraints', () => {
      const constraints: Constraint[] = [
        { type: 'requires', tool: 'charge', condition: 'authenticate' },
        { type: 'budget', tool: 'charge', maxCalls: 5 },
      ]
      const vigil = new Vigil({ constraints })

      expect(vigil.getConstraints()).toEqual(constraints)
    })
  })

  describe('afterToolCall result status', () => {
    it('records error status result as failure', () => {
      const vigil = new Vigil({
        constraints: [{ type: 'cascade', trigger: 'deploy', blocks: ['promote'] }],
      })

      vigil.afterToolCall(makeAfterEvent('deploy', {}, { status: 'error' }))
      const result = vigil.beforeToolCall(makeBeforeEvent('promote'))
      expect(result.type).toBe('deny')
    })
  })
})
