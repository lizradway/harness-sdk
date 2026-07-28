import { describe, expect, it } from 'vitest'
import { ContractEnforcer, StateTracker, groundPredicate, groundPredicates } from '../contract-enforcer.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'

describe('ContractEnforcer', () => {
  describe('groundPredicate', () => {
    it('grounds a parameterized predicate with tool input', () => {
      expect(groundPredicate('file_exists(path)', { path: '/tmp/x' })).toBe('file_exists(/tmp/x)')
    })

    it('leaves unmatched parameters as-is', () => {
      expect(groundPredicate('file_exists(path)', { name: 'foo' })).toBe('file_exists(path)')
    })

    it('handles predicates without parameters', () => {
      expect(groundPredicate('db_connected', { path: '/tmp/x' })).toBe('db_connected')
    })

    it('handles multiple parameters', () => {
      expect(groundPredicate('can_copy(source, dest)', { source: '/a', dest: '/b' })).toBe('can_copy(/a, /b)')
    })
  })

  describe('groundPredicates', () => {
    it('grounds a list of predicates', () => {
      const result = groundPredicates(['file_exists(path)', 'db_connected'], { path: '/tmp/x' })
      expect(result).toEqual(['file_exists(/tmp/x)', 'db_connected'])
    })
  })

  describe('StateTracker', () => {
    it('returns undefined for unknown predicates', () => {
      const tracker = new StateTracker()
      expect(tracker.check('file_exists(/tmp/x)')).toBeUndefined()
    })

    it('returns true for asserted predicates', () => {
      const tracker = new StateTracker()
      tracker.assert(['file_exists(/tmp/x)'])
      expect(tracker.check('file_exists(/tmp/x)')).toBe(true)
    })

    it('revoke removes predicates', () => {
      const tracker = new StateTracker()
      tracker.assert(['file_exists(/tmp/x)'])
      tracker.revoke(['file_exists(/tmp/x)'])
      expect(tracker.check('file_exists(/tmp/x)')).toBeUndefined()
    })

    it('checkAll returns violations under closed-world', () => {
      const tracker = new StateTracker()
      tracker.assert(['db_connected'])
      const violations = tracker.checkAll(['db_connected', 'file_exists(/tmp/x)'], true)
      expect(violations).toEqual(['file_exists(/tmp/x)'])
    })

    it('checkAll returns no violations under open-world for unknown', () => {
      const tracker = new StateTracker()
      const violations = tracker.checkAll(['file_exists(/tmp/x)'], false)
      expect(violations).toEqual([])
    })

    it('clear removes all facts', () => {
      const tracker = new StateTracker()
      tracker.assert(['a', 'b', 'c'])
      tracker.clear()
      expect(tracker.check('a')).toBeUndefined()
      expect(tracker.check('b')).toBeUndefined()
    })
  })

  describe('with overrides only (no LLM)', () => {
    it('allows tool call under open-world when state is unknown', async () => {
      const enforcer = new ContractEnforcer({
        overrides: {
          delete_file: {
            requires: ['file_exists(path)'],
            ensures: [],
            revokes: ['file_exists(path)'],
          },
        },
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_file', toolUseId: 'tool-1', input: { path: '/tmp/x' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('delete_file', () => {
        toolExecuted = true
        return 'deleted'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [enforcer],
        printer: false,
      })

      await agent.invoke('Delete it')
      expect(toolExecuted).toBe(true)
    })

    it('allows tool call when precondition is met (state tracked)', async () => {
      const enforcer = new ContractEnforcer({
        overrides: {
          write_file: {
            requires: [],
            ensures: ['file_exists(path)'],
            revokes: [],
          },
          delete_file: {
            requires: ['file_exists(path)'],
            ensures: [],
            revokes: ['file_exists(path)'],
          },
        },
      })

      let deleteExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { path: '/tmp/x', content: 'hello' } })
        .addTurn({ type: 'toolUseBlock', name: 'delete_file', toolUseId: 'tool-2', input: { path: '/tmp/x' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const writeTool = createMockTool('write_file', () => 'written')
      const deleteTool = createMockTool('delete_file', () => {
        deleteExecuted = true
        return 'deleted'
      })

      const agent = new Agent({
        model,
        tools: [writeTool, deleteTool],
        interventions: [enforcer],
        printer: false,
      })

      await agent.invoke('Write then delete')
      expect(deleteExecuted).toBe(true)
    })

    it('denies under closed-world when state is unknown', async () => {
      const enforcer = new ContractEnforcer({
        closedWorld: true,
        overrides: {
          delete_file: {
            requires: ['file_exists(path)'],
            ensures: [],
            revokes: ['file_exists(path)'],
          },
        },
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_file', toolUseId: 'tool-1', input: { path: '/tmp/x' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('delete_file', () => {
        toolExecuted = true
        return 'deleted'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [enforcer],
        printer: false,
      })

      await agent.invoke('Delete it')
      expect(toolExecuted).toBe(false)
    })

    it('allows tool with no preconditions', async () => {
      const enforcer = new ContractEnforcer({
        closedWorld: true,
        overrides: {
          search: {
            requires: [],
            ensures: [],
            revokes: [],
          },
        },
      })

      let toolExecuted = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'hello' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [enforcer],
        printer: false,
      })

      await agent.invoke('Search')
      expect(toolExecuted).toBe(true)
    })

    it('tracks state through ensures/revokes across multiple calls', async () => {
      const enforcer = new ContractEnforcer({
        closedWorld: true,
        overrides: {
          create_file: {
            requires: [],
            ensures: ['file_exists(path)'],
            revokes: [],
          },
          delete_file: {
            requires: ['file_exists(path)'],
            ensures: [],
            revokes: ['file_exists(path)'],
          },
        },
      })

      // Create -> Delete -> Delete (second should fail)
      let deleteCount = 0
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'create_file', toolUseId: 'tool-1', input: { path: '/tmp/x' } })
        .addTurn({ type: 'toolUseBlock', name: 'delete_file', toolUseId: 'tool-2', input: { path: '/tmp/x' } })
        .addTurn({ type: 'toolUseBlock', name: 'delete_file', toolUseId: 'tool-3', input: { path: '/tmp/x' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const createTool = createMockTool('create_file', () => 'created')
      const deleteTool = createMockTool('delete_file', () => {
        deleteCount++
        return 'deleted'
      })

      const agent = new Agent({
        model,
        tools: [createTool, deleteTool],
        interventions: [enforcer],
        printer: false,
      })

      await agent.invoke('Create then double delete')
      expect(deleteCount).toBe(1)
    })
  })

  describe('with LLM contract extraction', () => {
    it('infers contracts from tool descriptions', async () => {
      const extractionModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'extract-1',
        input: {
          contracts: [
            {
              tool: 'read_file',
              requires: ['file_exists(path)'],
              ensures: [],
              revokes: [],
            },
            {
              tool: 'write_file',
              requires: [],
              ensures: ['file_exists(path)'],
              revokes: [],
            },
          ],
        },
      })

      const enforcer = new ContractEnforcer({ model: extractionModel })

      const readTool = createMockTool('read_file', () => 'contents')
      readTool.toolSpec = { name: 'read_file', description: 'Read a file from disk' }

      const writeTool = createMockTool('write_file', () => 'ok')
      writeTool.toolSpec = { name: 'write_file', description: 'Write content to a file' }

      const runtimeModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'write_file', toolUseId: 'tool-1', input: { path: '/tmp/x', content: 'hi' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({
        model: runtimeModel,
        tools: [readTool, writeTool],
        interventions: [enforcer],
        printer: false,
      })

      await agent.invoke('Write something')

      const contracts = enforcer.getContracts()
      expect(contracts.get('read_file')).toEqual({
        requires: ['file_exists(path)'],
        ensures: [],
        revokes: [],
      })
      expect(contracts.get('write_file')).toEqual({
        requires: [],
        ensures: ['file_exists(path)'],
        revokes: [],
      })
    })

    it('overrides take precedence over LLM inference', async () => {
      const extractionModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'extract-1',
        input: {
          contracts: [
            {
              tool: 'delete_file',
              requires: ['file_exists(path)'],
              ensures: [],
              revokes: ['file_exists(path)'],
            },
          ],
        },
      })

      const enforcer = new ContractEnforcer({
        model: extractionModel,
        overrides: {
          delete_file: {
            requires: ['file_exists(path)', 'has_backup(path)'],
            ensures: [],
            revokes: ['file_exists(path)'],
          },
        },
      })

      const deleteTool = createMockTool('delete_file', () => 'deleted')
      deleteTool.toolSpec = { name: 'delete_file', description: 'Delete a file' }

      const runtimeModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({
        model: runtimeModel,
        tools: [deleteTool],
        interventions: [enforcer],
        printer: false,
      })

      await agent.invoke('Hi')

      const contracts = enforcer.getContracts()
      expect(contracts.get('delete_file')!.requires).toEqual(['file_exists(path)', 'has_backup(path)'])
    })
  })

  describe('getContracts / getState', () => {
    it('exposes contracts for inspection', async () => {
      const enforcer = new ContractEnforcer({
        overrides: {
          search: { requires: [], ensures: ['results_available'], revokes: [] },
        },
      })

      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
      const tool = createMockTool('search', () => 'results')
      const agent = new Agent({ model, tools: [tool], interventions: [enforcer], printer: false })
      await agent.invoke('Hi')

      expect(enforcer.getContracts().get('search')).toEqual({
        requires: [],
        ensures: ['results_available'],
        revokes: [],
      })
    })

    it('exposes state tracker for inspection', () => {
      const enforcer = new ContractEnforcer()
      const state = enforcer.getState()
      expect(state).toBeInstanceOf(StateTracker)
    })
  })
})
