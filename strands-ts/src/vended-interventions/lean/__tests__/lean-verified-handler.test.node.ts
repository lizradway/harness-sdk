import { describe, expect, it, vi } from 'vitest'
import { LeanVerifiedHandler } from '../lean-verified-handler.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import type { CheckerModule, CheckerResult, Codec } from '../lean-verified-handler.js'
import type { LifecycleEvent } from '../../../interventions/actions.js'
import type { BeforeToolCallEvent } from '../../../hooks/events.js'
import { deny, proceed } from '../../../interventions/actions.js'

function createMockChecker(resultFn: (input: string) => CheckerResult): CheckerModule {
  return {
    check(input: string): string {
      return JSON.stringify(resultFn(input))
    },
  }
}

function createAcceptChecker(): CheckerModule {
  return createMockChecker(() => ({ verdict: 'accept' }))
}

function createRejectChecker(reason = 'invariant violated'): CheckerModule {
  return createMockChecker(() => ({ verdict: 'reject', reason }))
}

function createPassthroughCodec(): Codec {
  return {
    encode(event: LifecycleEvent): unknown {
      return { eventType: (event.constructor as { name: string }).name }
    },
  }
}

describe('LeanVerifiedHandler', () => {
  describe('construction', () => {
    it('accepts a pre-loaded checker module', () => {
      const handler = new LeanVerifiedHandler({
        name: 'test-handler',
        checker: createAcceptChecker(),
        codec: createPassthroughCodec(),
      })

      expect(handler.name).toBe('test-handler')
      expect(handler.onError).toBe('throw')
    })

    it('accepts a factory function for lazy initialization', () => {
      const factory = vi.fn(() => createAcceptChecker())

      const handler = new LeanVerifiedHandler({
        name: 'lazy-handler',
        checker: factory,
        codec: createPassthroughCodec(),
      })

      expect(handler.name).toBe('lazy-handler')
      expect(factory).not.toHaveBeenCalled()
    })

    it('respects onError config', () => {
      const handler = new LeanVerifiedHandler({
        name: 'deny-on-error',
        checker: createAcceptChecker(),
        codec: createPassthroughCodec(),
        onError: 'deny',
      })

      expect(handler.onError).toBe('deny')
    })
  })

  describe('lazy initialization', () => {
    it('calls factory on first use and caches the result', async () => {
      const factory = vi.fn(() => createAcceptChecker())

      const handler = new LeanVerifiedHandler({
        name: 'lazy',
        checker: factory,
        codec: createPassthroughCodec(),
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => 'ok')
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(factory).toHaveBeenCalledTimes(1)
    })

    it('supports async factory functions', async () => {
      const factory = vi.fn(async () => createAcceptChecker())

      const handler = new LeanVerifiedHandler({
        name: 'async-factory',
        checker: factory,
        codec: createPassthroughCodec(),
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => 'ok')
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(factory).toHaveBeenCalledTimes(1)
    })

    it('ready() eagerly initializes the checker', async () => {
      const factory = vi.fn(() => createAcceptChecker())

      const handler = new LeanVerifiedHandler({
        name: 'eager',
        checker: factory,
        codec: createPassthroughCodec(),
      })

      await handler.ready()
      expect(factory).toHaveBeenCalledTimes(1)

      await handler.ready()
      expect(factory).toHaveBeenCalledTimes(1)
    })
  })

  describe('active methods', () => {
    it('defaults to beforeToolCall only', async () => {
      const checkFn = vi.fn(() => ({ verdict: 'accept' as const }))
      const checker = createMockChecker(checkFn)

      const handler = new LeanVerifiedHandler({
        name: 'defaults',
        checker,
        codec: createPassthroughCodec(),
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => 'ok')
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(checkFn).toHaveBeenCalledTimes(1)
    })

    it('skips checking for inactive methods', async () => {
      const checkFn = vi.fn(() => ({ verdict: 'reject' as const, reason: 'should not fire' }))
      const checker = createMockChecker(checkFn)

      const handler = new LeanVerifiedHandler({
        name: 'no-tool-check',
        checker,
        codec: createPassthroughCodec(),
        activeMethods: { beforeToolCall: false },
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(checkFn).not.toHaveBeenCalled()
      expect(toolExecuted).toBe(true)
    })
  })

  describe('default decode mapping', () => {
    it('accept → proceed (tool executes)', async () => {
      const handler = new LeanVerifiedHandler({
        name: 'accept-handler',
        checker: createAcceptChecker(),
        codec: createPassthroughCodec(),
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(toolExecuted).toBe(true)
    })

    it('reject → deny (tool blocked)', async () => {
      const handler = new LeanVerifiedHandler({
        name: 'reject-handler',
        checker: createRejectChecker('data loss detected'),
        codec: createPassthroughCodec(),
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'dangerous_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      const tool = createMockTool('dangerous_tool', () => {
        toolExecuted = true
        return 'deleted'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Do it')

      expect(toolExecuted).toBe(false)
    })

    it('guide → guide (feedback provided)', async () => {
      const checker = createMockChecker(() => ({ verdict: 'guide', reason: 'consider alternatives' }))

      const handler = new LeanVerifiedHandler({
        name: 'guide-handler',
        checker,
        codec: createPassthroughCodec(),
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Adjusted' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(toolExecuted).toBe(false)
    })

    it('reject without reason uses default message', async () => {
      const checker = createMockChecker(() => ({ verdict: 'reject' }))

      const handler = new LeanVerifiedHandler({
        name: 'no-reason',
        checker,
        codec: createPassthroughCodec(),
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(toolExecuted).toBe(false)
    })
  })

  describe('codec', () => {
    it('encode returning undefined skips checking (proceeds)', async () => {
      const checkFn = vi.fn(() => ({ verdict: 'reject' as const, reason: 'should not fire' }))
      const checker = createMockChecker(checkFn)

      const codec: Codec = {
        encode: () => undefined,
      }

      const handler = new LeanVerifiedHandler({
        name: 'skip-codec',
        checker,
        codec,
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(checkFn).not.toHaveBeenCalled()
      expect(toolExecuted).toBe(true)
    })

    it('custom decode overrides default mapping', async () => {
      const checker = createMockChecker(() => ({ verdict: 'reject', reason: 'blocked', patch: { redact: true } }))

      const codec: Codec = {
        encode: (event) => ({ tool: (event as BeforeToolCallEvent).toolUse?.name }),
        decode: (result) => {
          if (result.patch) return proceed({ reason: 'patched and allowed' })
          return deny(result.reason ?? 'denied')
        },
      }

      const handler = new LeanVerifiedHandler({
        name: 'custom-decode',
        checker,
        codec,
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(toolExecuted).toBe(true)
    })

    it('passes encoded event data to the checker', async () => {
      const receivedInputs: string[] = []
      const checker: CheckerModule = {
        check(input: string): string {
          receivedInputs.push(input)
          return JSON.stringify({ verdict: 'accept' })
        },
      }

      const codec: Codec = {
        encode: (event) => ({
          toolName: (event as BeforeToolCallEvent).toolUse?.name,
          toolInput: (event as BeforeToolCallEvent).toolUse?.input,
        }),
      }

      const handler = new LeanVerifiedHandler({
        name: 'data-passthrough',
        checker,
        codec,
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'hello' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('search', () => 'results')
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(receivedInputs).toHaveLength(1)
      const parsed = JSON.parse(receivedInputs[0]!) as unknown
      expect(parsed).toEqual({ toolName: 'search', toolInput: { query: 'hello' } })
    })
  })

  describe('error handling', () => {
    it('onError=throw propagates checker errors', async () => {
      const checker: CheckerModule = {
        check(): string {
          throw new Error('checker crashed')
        },
      }

      const handler = new LeanVerifiedHandler({
        name: 'throw-handler',
        checker,
        codec: createPassthroughCodec(),
        onError: 'throw',
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => 'ok')
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })

      await expect(agent.invoke('Go')).rejects.toThrow('checker crashed')
    })

    it('onError=proceed allows tool execution when checker throws', async () => {
      const checker: CheckerModule = {
        check(): string {
          throw new Error('checker crashed')
        },
      }

      const handler = new LeanVerifiedHandler({
        name: 'proceed-handler',
        checker,
        codec: createPassthroughCodec(),
        onError: 'proceed',
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(toolExecuted).toBe(true)
    })

    it('onError=deny blocks tool execution when checker throws', async () => {
      const checker: CheckerModule = {
        check(): string {
          throw new Error('checker crashed')
        },
      }

      const handler = new LeanVerifiedHandler({
        name: 'deny-handler',
        checker,
        codec: createPassthroughCodec(),
        onError: 'deny',
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'test_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('test_tool', () => {
        toolExecuted = true
        return 'ok'
      })
      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Go')

      expect(toolExecuted).toBe(false)
    })
  })

  describe('conditional checking based on tool input', () => {
    it('rejects tool calls that violate the invariant', async () => {
      const checker = createMockChecker((input) => {
        const data = JSON.parse(input) as { dangerous?: boolean }
        if (data.dangerous) return { verdict: 'reject', reason: 'dangerous operation detected' }
        return { verdict: 'accept' }
      })

      const codec: Codec = {
        encode: (event) => (event as BeforeToolCallEvent).toolUse?.input,
      }

      const handler = new LeanVerifiedHandler({
        name: 'conditional-checker',
        checker,
        codec,
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'action', toolUseId: 'tool-1', input: { dangerous: true } })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      const tool = createMockTool('action', () => {
        toolExecuted = true
        return 'done'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Do something dangerous')

      expect(toolExecuted).toBe(false)
    })

    it('allows safe tool calls through', async () => {
      const checker = createMockChecker((input) => {
        const data = JSON.parse(input) as { dangerous?: boolean }
        if (data.dangerous) return { verdict: 'reject', reason: 'dangerous operation detected' }
        return { verdict: 'accept' }
      })

      const codec: Codec = {
        encode: (event) => (event as BeforeToolCallEvent).toolUse?.input,
      }

      const handler = new LeanVerifiedHandler({
        name: 'conditional-checker',
        checker,
        codec,
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'action', toolUseId: 'tool-1', input: { dangerous: false } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('action', () => {
        toolExecuted = true
        return 'done'
      })

      const agent = new Agent({ model, tools: [tool], interventions: [handler], printer: false })
      await agent.invoke('Do something safe')

      expect(toolExecuted).toBe(true)
    })
  })
})
