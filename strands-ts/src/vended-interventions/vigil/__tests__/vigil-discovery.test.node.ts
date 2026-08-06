import { describe, it, expect } from 'vitest'
import { Vigil, InMemoryVigilStorage } from '../vigil.js'
import { BeforeToolCallEvent, AfterToolCallEvent } from '../../../hooks/events.js'

function makeBeforeEvent(toolName: string, input: unknown = {}): BeforeToolCallEvent {
  return {
    type: 'beforeToolCallEvent',
    agent: { appState: { get: () => undefined, set: () => {} } },
    toolUse: { name: toolName, toolUseId: `id-${toolName}-${Math.random()}`, input },
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
    toolUse: { name: toolName, toolUseId: `id-${toolName}-${Math.random()}`, input },
    tool: undefined,
    result: { toolUseId: `id-${toolName}`, status: options.status ?? 'success', content: [] },
    invocationState: {},
    error: options.error,
  } as unknown as AfterToolCallEvent
}

interface ScenarioResult {
  totalRounds: number
  failures: number
  blocked: number
  successes: number
  discoveredConstraints: number
  failureRate: string
  postDiscoveryFailureRate: string
}

describe('Vigil discovery: performance scenarios', () => {
  describe('prerequisite discovery', () => {
    it('scenario: charge requires authenticate (30 rounds)', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })
      const result = await runPrerequisiteScenario(vigil, 30)

      expect(result.discoveredConstraints).toBeGreaterThanOrEqual(1)
      expect(result.failures).toBeLessThanOrEqual(4)
      expect(result.blocked).toBeGreaterThan(0)
      expect(result.successes).toBeGreaterThan(0)
    })

    it('scenario: promote requires health_check (30 rounds)', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })
      const result = await runOrderingScenario(vigil, 30, {
        prerequisite: 'health_check',
        dependent: 'promote',
      })

      expect(result.discoveredConstraints).toBeGreaterThanOrEqual(1)
      expect(result.failures).toBeLessThanOrEqual(4)
    })

    it('scenario: low minEvidence (2) discovers faster than high', async () => {
      const vigilLow = new Vigil({ discover: true, minEvidence: 2 })
      const vigilHigh = new Vigil({ discover: true, minEvidence: 5 })
      const resultLow = await runPrerequisiteScenario(vigilLow, 30)
      const resultHigh = await runPrerequisiteScenario(vigilHigh, 30)

      expect(resultLow.failures).toBeLessThan(resultHigh.failures)
      expect(resultLow.discoveredConstraints).toBeGreaterThanOrEqual(1)
    })

    it('scenario: high minEvidence (5) takes longer to converge', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 5 })
      const result = await runPrerequisiteScenario(vigil, 40)

      expect(result.failures).toBeGreaterThanOrEqual(5)
      expect(result.discoveredConstraints).toBeGreaterThanOrEqual(1)
    })
  })

  describe('cross-agent transfer', () => {
    it('agent B has zero failures from first call', async () => {
      const storage = new InMemoryVigilStorage()

      // Agent A learns
      const agentA = new Vigil({ discover: true, minEvidence: 3, storage })
      await runPrerequisiteScenario(agentA, 15)
      await agentA.persist()

      // Agent B loads — protected immediately
      const agentB = new Vigil({ discover: true, storage })
      let failures = 0
      let blocked = 0

      for (let round = 0; round < 10; round++) {
        const result = await agentB.beforeToolCall(makeBeforeEvent('charge'))
        if (result.type === 'deny') {
          blocked++
        } else {
          await agentB.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
          failures++
        }
      }

      expect(failures).toBe(0)
      expect(blocked).toBe(10)
    })

    it('agent B still allows valid sequences', async () => {
      const storage = new InMemoryVigilStorage()

      const agentA = new Vigil({ discover: true, minEvidence: 3, storage })
      await runPrerequisiteScenario(agentA, 15)
      await agentA.persist()

      const agentB = new Vigil({ discover: true, storage })
      await agentB.afterToolCall(makeAfterEvent('authenticate'))
      const result = await agentB.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('proceed')
    })
  })

  describe('multiple constraint discovery', () => {
    it('discovers two independent prerequisites simultaneously', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })

      // charge requires authenticate
      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      // refund also requires authenticate
      for (let index = 0; index < 3; index++) {
        await vigil.afterToolCall(makeAfterEvent('refund', {}, { error: new Error('403') }))
      }
      // authenticate then both succeed
      await vigil.afterToolCall(makeAfterEvent('authenticate'))
      await vigil.afterToolCall(makeAfterEvent('charge'))
      await vigil.afterToolCall(makeAfterEvent('refund'))

      const enforcing = vigil.getEnforcingConstraints()
      const chargePrereq = enforcing.find(
        (record) => record.constraint.type === 'requires' &&
          (record.constraint as { tool: string }).tool === 'charge'
      )
      const refundPrereq = enforcing.find(
        (record) => record.constraint.type === 'requires' &&
          (record.constraint as { tool: string }).tool === 'refund'
      )

      expect(chargePrereq).toBeDefined()
      expect(refundPrereq).toBeDefined()
    })
  })

  describe('no false positives', () => {
    it('does not discover constraint when failures have varied causes', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })

      // search fails sometimes but also succeeds without any prerequisite
      await vigil.afterToolCall(makeAfterEvent('search', {}, { error: new Error('timeout') }))
      await vigil.afterToolCall(makeAfterEvent('search'))
      await vigil.afterToolCall(makeAfterEvent('search', {}, { error: new Error('timeout') }))
      await vigil.afterToolCall(makeAfterEvent('search'))
      await vigil.afterToolCall(makeAfterEvent('search', {}, { error: new Error('timeout') }))
      await vigil.afterToolCall(makeAfterEvent('search'))

      const enforcing = vigil.getEnforcingConstraints()
      const falsePrereq = enforcing.find(
        (record) => record.constraint.type === 'requires' &&
          (record.constraint as { tool: string }).tool === 'search'
      )
      expect(falsePrereq).toBeUndefined()
    })

    it('does not discover from only failures (no success confirmation)', async () => {
      const vigil = new Vigil({ discover: true, minEvidence: 3 })

      for (let index = 0; index < 10; index++) {
        await vigil.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }

      const enforcing = vigil.getEnforcingConstraints()
      expect(enforcing).toHaveLength(0)
    })
  })

  describe('enforcement latency', () => {
    it('evaluates 1000 constraints in under 10ms', async () => {
      const constraints = Array.from({ length: 1000 }, (_, index) => ({
        type: 'requires' as const,
        tool: `tool_${index}`,
        condition: `prereq_${index}`,
      }))

      const vigil = new Vigil({ constraints })

      const start = globalThis.performance.now()
      for (let round = 0; round < 100; round++) {
        await vigil.beforeToolCall(makeBeforeEvent('unrelated_tool'))
      }
      const elapsed = globalThis.performance.now() - start

      expect(elapsed).toBeLessThan(100)
    })
  })
})

async function runPrerequisiteScenario(vigil: Vigil, totalRounds: number): Promise<ScenarioResult> {
  let failures = 0
  let blocked = 0
  let successes = 0

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

  const discoveredConstraints = vigil.getEnforcingConstraints().filter(
    (record) => record.source === 'discovered'
  ).length

  return {
    totalRounds,
    failures,
    blocked,
    successes,
    discoveredConstraints,
    failureRate: `${((failures / totalRounds) * 100).toFixed(1)}%`,
    postDiscoveryFailureRate: failures <= 4 ? '0%' : `${(((failures - 3) / (totalRounds - 4)) * 100).toFixed(1)}%`,
  }
}

async function runOrderingScenario(
  vigil: Vigil,
  totalRounds: number,
  config: { prerequisite: string; dependent: string }
): Promise<ScenarioResult> {
  let failures = 0
  let blocked = 0
  let successes = 0

  for (let round = 0; round < totalRounds; round++) {
    const doesPrereqFirst = round % 5 === 4

    if (doesPrereqFirst) {
      await vigil.afterToolCall(makeAfterEvent(config.prerequisite))
      const result = await vigil.beforeToolCall(makeBeforeEvent(config.dependent))
      if (result.type === 'deny') {
        blocked++
      } else {
        await vigil.afterToolCall(makeAfterEvent(config.dependent))
        successes++
      }
    } else {
      const result = await vigil.beforeToolCall(makeBeforeEvent(config.dependent))
      if (result.type === 'deny') {
        blocked++
      } else {
        await vigil.afterToolCall(makeAfterEvent(config.dependent, {}, { error: new Error('precondition failed') }))
        failures++
      }
    }
  }

  const discoveredConstraints = vigil.getEnforcingConstraints().filter(
    (record) => record.source === 'discovered'
  ).length

  return {
    totalRounds,
    failures,
    blocked,
    successes,
    discoveredConstraints,
    failureRate: `${((failures / totalRounds) * 100).toFixed(1)}%`,
    postDiscoveryFailureRate: failures <= 4 ? '0%' : `${(((failures - 3) / (totalRounds - 4)) * 100).toFixed(1)}%`,
  }
}
