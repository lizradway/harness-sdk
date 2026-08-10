import { describe, it, expect } from 'vitest'
import { Trellis, InMemoryTrellisStorage } from '../trellis.js'
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
  minedConstraints: number
  failureRate: string
  postMiningFailureRate: string
}

describe('Trellis mining: performance scenarios', () => {
  describe('prerequisite mining', () => {
    it('scenario: charge requires authenticate (30 rounds)', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })
      const result = await runPrerequisiteScenario(trellis, 30)

      expect(result.minedConstraints).toBeGreaterThanOrEqual(1)
      expect(result.failures).toBeLessThanOrEqual(4)
      expect(result.blocked).toBeGreaterThan(0)
      expect(result.successes).toBeGreaterThan(0)
    })

    it('scenario: promote requires health_check (30 rounds)', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })
      const result = await runOrderingScenario(trellis, 30, {
        prerequisite: 'health_check',
        dependent: 'promote',
      })

      expect(result.minedConstraints).toBeGreaterThanOrEqual(1)
      expect(result.failures).toBeLessThanOrEqual(4)
    })

    it('scenario: low minEvidence (2) mines faster than high', async () => {
      const trellisLow = new Trellis({ discover: true, minEvidence: 2 })
      const trellisHigh = new Trellis({ discover: true, minEvidence: 5 })
      const resultLow = await runPrerequisiteScenario(trellisLow, 30)
      const resultHigh = await runPrerequisiteScenario(trellisHigh, 30)

      expect(resultLow.failures).toBeLessThan(resultHigh.failures)
      expect(resultLow.minedConstraints).toBeGreaterThanOrEqual(1)
    })

    it('scenario: high minEvidence (5) takes longer to converge', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 5 })
      const result = await runPrerequisiteScenario(trellis, 40)

      expect(result.failures).toBeGreaterThanOrEqual(5)
      expect(result.minedConstraints).toBeGreaterThanOrEqual(1)
    })
  })

  describe('cross-agent transfer', () => {
    it('agent B has zero failures from first call', async () => {
      const storage = new InMemoryTrellisStorage()

      const agentA = new Trellis({ discover: true, minEvidence: 3, storage })
      await runPrerequisiteScenario(agentA, 15)
      await agentA.persist()

      const agentB = new Trellis({ discover: true, storage })
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
      const storage = new InMemoryTrellisStorage()

      const agentA = new Trellis({ discover: true, minEvidence: 3, storage })
      await runPrerequisiteScenario(agentA, 15)
      await agentA.persist()

      const agentB = new Trellis({ discover: true, storage })
      await agentB.afterToolCall(makeAfterEvent('authenticate'))
      const result = await agentB.beforeToolCall(makeBeforeEvent('charge'))
      expect(result.type).toBe('proceed')
    })
  })

  describe('multiple constraint mining', () => {
    it('mines two independent prerequisites simultaneously', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })

      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }
      for (let index = 0; index < 3; index++) {
        await trellis.afterToolCall(makeAfterEvent('refund', {}, { error: new Error('403') }))
      }
      await trellis.afterToolCall(makeAfterEvent('authenticate'))
      await trellis.afterToolCall(makeAfterEvent('charge'))
      await trellis.afterToolCall(makeAfterEvent('refund'))

      const enforcing = trellis.getEnforcingConstraints()
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
    it('does not mine constraint when failures have varied causes', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })

      await trellis.afterToolCall(makeAfterEvent('search', {}, { error: new Error('timeout') }))
      await trellis.afterToolCall(makeAfterEvent('search'))
      await trellis.afterToolCall(makeAfterEvent('search', {}, { error: new Error('timeout') }))
      await trellis.afterToolCall(makeAfterEvent('search'))
      await trellis.afterToolCall(makeAfterEvent('search', {}, { error: new Error('timeout') }))
      await trellis.afterToolCall(makeAfterEvent('search'))

      const enforcing = trellis.getEnforcingConstraints()
      const falsePrereq = enforcing.find(
        (record) => record.constraint.type === 'requires' &&
          (record.constraint as { tool: string }).tool === 'search'
      )
      expect(falsePrereq).toBeUndefined()
    })

    it('does not mine from only failures (no success confirmation)', async () => {
      const trellis = new Trellis({ discover: true, minEvidence: 3 })

      for (let index = 0; index < 10; index++) {
        await trellis.afterToolCall(makeAfterEvent('charge', {}, { error: new Error('403') }))
      }

      const enforcing = trellis.getEnforcingConstraints()
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

      const trellis = new Trellis({ compiledConstraints: constraints })

      const start = globalThis.performance.now()
      for (let round = 0; round < 100; round++) {
        await trellis.beforeToolCall(makeBeforeEvent('unrelated_tool'))
      }
      const elapsed = globalThis.performance.now() - start

      expect(elapsed).toBeLessThan(100)
    })
  })
})

async function runPrerequisiteScenario(trellis: Trellis, totalRounds: number): Promise<ScenarioResult> {
  let failures = 0
  let blocked = 0
  let successes = 0

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

  const minedConstraints = trellis.getEnforcingConstraints().filter(
    (record) => record.source === 'discovered'
  ).length

  return {
    totalRounds,
    failures,
    blocked,
    successes,
    minedConstraints,
    failureRate: `${((failures / totalRounds) * 100).toFixed(1)}%`,
    postMiningFailureRate: failures <= 4 ? '0%' : `${(((failures - 3) / (totalRounds - 4)) * 100).toFixed(1)}%`,
  }
}

async function runOrderingScenario(
  trellis: Trellis,
  totalRounds: number,
  config: { prerequisite: string; dependent: string }
): Promise<ScenarioResult> {
  let failures = 0
  let blocked = 0
  let successes = 0

  for (let round = 0; round < totalRounds; round++) {
    const doesPrereqFirst = round % 5 === 4

    if (doesPrereqFirst) {
      await trellis.afterToolCall(makeAfterEvent(config.prerequisite))
      const result = await trellis.beforeToolCall(makeBeforeEvent(config.dependent))
      if (result.type === 'deny') {
        blocked++
      } else {
        await trellis.afterToolCall(makeAfterEvent(config.dependent))
        successes++
      }
    } else {
      const result = await trellis.beforeToolCall(makeBeforeEvent(config.dependent))
      if (result.type === 'deny') {
        blocked++
      } else {
        await trellis.afterToolCall(makeAfterEvent(config.dependent, {}, { error: new Error('precondition failed') }))
        failures++
      }
    }
  }

  const minedConstraints = trellis.getEnforcingConstraints().filter(
    (record) => record.source === 'discovered'
  ).length

  return {
    totalRounds,
    failures,
    blocked,
    successes,
    minedConstraints,
    failureRate: `${((failures / totalRounds) * 100).toFixed(1)}%`,
    postMiningFailureRate: failures <= 4 ? '0%' : `${(((failures - 3) / (totalRounds - 4)) * 100).toFixed(1)}%`,
  }
}
