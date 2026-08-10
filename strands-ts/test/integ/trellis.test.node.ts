import { describe, it } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { Trellis, InMemoryTrellisStorage } from '$/sdk/vended-interventions/trellis/trellis.js'
import { allProviders } from './__fixtures__/model-providers.js'

/**
 * Benchmark: scenarios where model self-correction is structurally impossible.
 *
 * Each invocation uses a FRESH agent (no conversation history carryover) but the
 * same Trellis instance (accumulating observations across invocations).
 */

let apiCallCount = 0
let sessionActive = false

function resetState(): void {
  apiCallCount = 0
  sessionActive = false
}

const activateSessionTool = tool({
  name: 'activate_session',
  description: 'Activate a processing session.',
  inputSchema: z.object({ mode: z.string().describe('The session mode to activate') }),
  callback: async ({ mode }) => {
    sessionActive = true
    return `Session activated in ${mode} mode.`
  },
})

const processItemTool = tool({
  name: 'process_item',
  description: 'Process a work item. Call once per item.',
  inputSchema: z.object({ item_id: z.string().describe('The item identifier to process') }),
  callback: async ({ item_id }) => {
    apiCallCount++
    if (apiCallCount > 3) {
      throw new Error('service unavailable')
    }
    return `Processed ${item_id} successfully. (${apiCallCount}/3 quota used)`
  },
})

const submitResultTool = tool({
  name: 'submit_result',
  description: 'Submit the final result of processing.',
  inputSchema: z.object({ summary: z.string().describe('Summary of what was processed') }),
  callback: async ({ summary }) => {
    if (!sessionActive) {
      throw new Error('submission rejected')
    }
    return `Result submitted: ${summary}`
  },
})

describe.each(allProviders)('Trellis benchmark with $name', ({ name, skip, createModel, supports }) => {
  describe.skipIf(skip || !supports.tools)(`${name} mining scenarios`, () => {
    it('budget: mines rate limit from repeated failures across fresh agents', async () => {
      resetState()
      const storage = new InMemoryTrellisStorage()
      const trellis = new Trellis({ discover: true, minEvidence: 2, storage })

      const tools = [processItemTool]

      console.log(`\n[Budget Mining: ${name}]`)

      for (let round = 0; round < 4; round++) {
        apiCallCount = 0
        trellis.resetTrajectory()

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'You are a batch processor. Process every item the user gives you by calling process_item for each one. ' +
            'Do not skip any items. Call process_item exactly once per item.',
          tools,
          interventions: [trellis],
          maxTurns: 12,
        })

        const items = ['A', 'B', 'C', 'D', 'E'].map((letter) => `ITEM-${round}-${letter}`)
        const result = await agent.invoke(`Process these items: ${items.join(', ')}`)

        const overLimit = Math.max(0, apiCallCount - 3)
        console.log(`  Round ${round + 1}: ${apiCallCount} calls, ${overLimit} over limit, stop=${result.stopReason}`)

        if (round === 0) {
          for (const msg of agent.messages) {
            for (const block of msg.content) {
              if (block.type === 'toolUseBlock') console.log(`    [tool_use] ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`)
              if (block.type === 'toolResultBlock') console.log(`    [result] ${block.status}: ${JSON.stringify(block.content).slice(0, 80)}`)
              if (block.type === 'textBlock' && msg.role === 'assistant') console.log(`    [text] ${block.text.slice(0, 120)}`)
            }
          }
        }
      }

      const mined = trellis.getConstraintRecords().filter((record) => record.source === 'discovered')
      const enforcing = trellis.getEnforcingConstraints().filter((record) => record.source === 'discovered')
      console.log(`  Mined: ${mined.length}, Enforcing: ${enforcing.length}`)
      for (const record of mined) {
        console.log(`    ${record.status}: ${JSON.stringify(record.constraint)}`)
      }
    }, 240_000)

    it('opaque prerequisite: mines submit requires activate across fresh agents', async () => {
      const storage = new InMemoryTrellisStorage()
      const trellis = new Trellis({ discover: true, minEvidence: 2, storage })

      const tools = [activateSessionTool, submitResultTool]

      console.log(`\n[Opaque Prerequisite: ${name}]`)

      for (let round = 0; round < 3; round++) {
        resetState()
        trellis.resetTrajectory()

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'You are a results submission assistant. Submit results when asked. ' +
            'Use submit_result to submit. Use activate_session only if the user explicitly asks.',
          tools,
          interventions: [trellis],
          maxTurns: 8,
        })

        await agent.invoke(`Submit the result: "Batch ${round + 1} complete."`)
        console.log(`  Round ${round + 1}: session=${sessionActive}`)
      }

      resetState()
      trellis.resetTrajectory()
      const agent4 = new Agent({
        model: createModel(),
        printer: false,
        systemPrompt:
          'You are a results submission assistant. Follow the user instructions exactly.',
        tools,
        interventions: [trellis],
        maxTurns: 8,
      })
      await agent4.invoke('First activate_session in "batch" mode, then submit_result with summary "Final batch".')
      console.log(`  Round 4 (with activate): session=${sessionActive}`)

      const mined = trellis.getConstraintRecords().filter((record) => record.source === 'discovered')
      const enforcing = trellis.getEnforcingConstraints().filter((record) => record.source === 'discovered')
      console.log(`  Mined: ${mined.length}, Enforcing: ${enforcing.length}`)
      for (const record of mined) {
        console.log(`    ${record.status}: ${JSON.stringify(record.constraint)}`)
        console.log(`    evidence: failures=${record.evidence.failures}, successes=${record.evidence.successes}`)
      }

      if (enforcing.length > 0) {
        resetState()
        trellis.resetTrajectory()
        const agent5 = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'You are a results submission assistant. Submit results when asked.',
          tools,
          interventions: [trellis],
          maxTurns: 8,
        })
        await agent5.invoke('Submit the result: "Post-mining test".')
        console.log(`  Round 5 (post-mining): session=${sessionActive}`)
      }
    }, 240_000)
  })
})
