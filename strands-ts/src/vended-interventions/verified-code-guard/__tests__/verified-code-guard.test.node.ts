import { describe, expect, it, vi } from 'vitest'
import { VerifiedCodeGuard } from '../verified-code-guard.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import type { Verifier, VerifyResult } from '../verified-code-guard.js'
import type { AfterToolCallEvent } from '../../../hooks/events.js'

function createMockVerifier(results: VerifyResult | VerifyResult[]): Verifier & { calls: Array<{ code: string; metadata: { filePath?: string; language?: string } | undefined }> } {
  const queue = Array.isArray(results) ? [...results] : [results]
  const verifier = {
    calls: [] as Array<{ code: string; metadata: { filePath?: string; language?: string } | undefined }>,
    async verify(code: string, metadata?: { filePath?: string; language?: string }): Promise<VerifyResult> {
      verifier.calls.push({ code, metadata })
      return queue.length > 1 ? (queue.shift() as VerifyResult) : (queue[0] as VerifyResult)
    },
  }
  return verifier
}

describe('VerifiedCodeGuard', () => {
  describe('tool filtering', () => {
    it('passes through non-matching tools without verification', async () => {
      const verifier = createMockVerifier({ verified: true })
      const guard = new VerifiedCodeGuard({ verifier })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'read_file', toolUseId: 'tool-1', input: { path: '/tmp/x.ts' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('read_file', () => {
        toolExecuted = true
        return 'file contents'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      await agent.invoke('Read the file')

      expect(toolExecuted).toBe(true)
      expect(verifier.calls).toHaveLength(0)
    })

    it('uses custom toolNames when configured', async () => {
      const verifier = createMockVerifier({ verified: true })
      const guard = new VerifiedCodeGuard({ verifier, toolNames: ['custom_write'] })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'custom_write', toolUseId: 'tool-1', input: { content: 'code' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('custom_write', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      await agent.invoke('Write it')

      expect(verifier.calls).toHaveLength(1)
    })
  })

  describe('verification success', () => {
    it('proceeds when verification passes', async () => {
      const verifier = createMockVerifier({ verified: true })
      const guard = new VerifiedCodeGuard({ verifier })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { file_path: '/tmp/x.ts', content: 'const x = 1' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      const result = await agent.invoke('Write code')

      expect(result.stopReason).toBe('endTurn')
      expect(verifier.calls).toHaveLength(1)
      expect(verifier.calls[0]).toEqual({ code: 'const x = 1', metadata: { filePath: '/tmp/x.ts' } })
    })
  })

  describe('verification failure', () => {
    it('guides with error details on verification failure', async () => {
      const verifier = createMockVerifier([
        { verified: false, errors: [{ line: 5, message: 'type mismatch' }], suggestions: ['Use number instead of string'] },
        { verified: true },
      ])
      const guard = new VerifiedCodeGuard({ verifier })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { file_path: '/tmp/x.ts', content: 'bad code' } })
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-2', input: { file_path: '/tmp/x.ts', content: 'good code' } })
        .addTurn({ type: 'textBlock', text: 'Fixed' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      const result = await agent.invoke('Write code')

      expect(result.stopReason).toBe('endTurn')
      expect(verifier.calls).toHaveLength(2)
      expect(verifier.calls[0]!.code).toBe('bad code')
      expect(verifier.calls[1]!.code).toBe('good code')
    })

    it('escalates to deny after maxRetries', async () => {
      const verifier = createMockVerifier({ verified: false, errors: [{ message: 'invariant violated' }] })
      const guard = new VerifiedCodeGuard({ verifier, maxRetries: 2 })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { file_path: '/tmp/x.ts', content: 'bad' } })
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-2', input: { file_path: '/tmp/x.ts', content: 'still bad' } })
        .addTurn({ type: 'textBlock', text: 'Gave up' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      const result = await agent.invoke('Write code')

      expect(result.stopReason).toBe('endTurn')
      expect(verifier.calls).toHaveLength(2)

      const messages = agent.messages
      const lastToolResult = messages.flatMap((message) => message.content).find(
        (block) => block.type === 'toolResultBlock' && block.content.some(
          (content) => content.type === 'textBlock' && content.text.includes('DENIED')
        )
      )
      expect(lastToolResult).toBeDefined()
    })
  })

  describe('code extraction', () => {
    it('uses custom extractCode function', async () => {
      const verifier = createMockVerifier({ verified: true })
      const extractCode = vi.fn((_event: AfterToolCallEvent) => ({
        code: 'extracted-code',
        filePath: '/custom/path.ts',
      }))

      const guard = new VerifiedCodeGuard({ verifier, extractCode })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { weird_field: 'data' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      await agent.invoke('Write code')

      expect(extractCode).toHaveBeenCalledTimes(1)
      expect(verifier.calls).toHaveLength(1)
      expect(verifier.calls[0]).toEqual({ code: 'extracted-code', metadata: { filePath: '/custom/path.ts' } })
    })

    it('skips verification when extractCode returns undefined', async () => {
      const verifier = createMockVerifier({ verified: false, errors: [{ message: 'would fail' }] })
      const extractCode = vi.fn(() => undefined)

      const guard = new VerifiedCodeGuard({ verifier, extractCode })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('write_file', () => {
        toolExecuted = true
        return 'written'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      await agent.invoke('Write code')

      expect(toolExecuted).toBe(true)
      expect(extractCode).toHaveBeenCalledTimes(1)
      expect(verifier.calls).toHaveLength(0)
    })

    it('skips verification when default extractor finds no code field', async () => {
      const verifier = createMockVerifier({ verified: false, errors: [{ message: 'would fail' }] })
      const guard = new VerifiedCodeGuard({ verifier })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { no_code_here: true } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      await agent.invoke('Write code')

      expect(verifier.calls).toHaveLength(0)
    })
  })

  describe('retry tracking', () => {
    it('resets retry count on success', async () => {
      const verifier = createMockVerifier([
        { verified: false, errors: [{ message: 'error 1' }] },
        { verified: true },
        { verified: false, errors: [{ message: 'error 2' }] },
        { verified: true },
      ])
      const guard = new VerifiedCodeGuard({ verifier, maxRetries: 2 })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { file_path: '/tmp/x.ts', content: 'bad 1' } })
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-2', input: { file_path: '/tmp/x.ts', content: 'good 1' } })
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-3', input: { file_path: '/tmp/x.ts', content: 'bad 2' } })
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-4', input: { file_path: '/tmp/x.ts', content: 'good 2' } })
        .addTurn({ type: 'textBlock', text: 'All done' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      const result = await agent.invoke('Write code')

      expect(result.stopReason).toBe('endTurn')
      expect(verifier.calls).toHaveLength(4)
    })
  })

  describe('error handling', () => {
    it('throws when verifier throws and onError is throw', async () => {
      const verifier: Verifier = {
        async verify(): Promise<VerifyResult> {
          throw new Error('verifier crashed')
        },
      }
      const guard = new VerifiedCodeGuard({ verifier, onError: 'throw' })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { content: 'code' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      await expect(agent.invoke('Write code')).rejects.toThrow('verifier crashed')
    })

    it('proceeds when verifier throws and onError is proceed', async () => {
      const verifier: Verifier = {
        async verify(): Promise<VerifyResult> {
          throw new Error('verifier crashed')
        },
      }
      const guard = new VerifiedCodeGuard({ verifier, onError: 'proceed' })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { content: 'code' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('write_file', () => 'written')

      const agent = new Agent({ model, tools: [tool], interventions: [guard], printer: false })
      const result = await agent.invoke('Write code')

      expect(result.stopReason).toBe('endTurn')
    })
  })
})
