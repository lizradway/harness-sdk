import { describe, expect, it } from 'vitest'
import { DogwoodAuthorization } from '../dogwood.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { resolve } from 'node:path'

const FIXTURES = resolve(import.meta.dirname!, 'fixtures')

const ACTION_SCHEMA = `
entity User = { role: String };
entity Resource;

action "search" appliesTo {
  principal: [User], resource: [Resource],
  context: { input: { query: String } }
};

action "delete_record" appliesTo {
  principal: [User], resource: [Resource],
  context: { input: { id: String } }
};

action "query" appliesTo {
  principal: [User], resource: [Resource],
  context: { input: {} }
};

action "send_email" appliesTo {
  principal: [User], resource: [Resource],
  context: { input: { to: String } }
};
`

const NAMESPACED_ACTION_SCHEMA = `
namespace App {
  entity User;
  entity Resource;

  action "search" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: { query: String } }
  };

  action "read_data" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: { document: String } }
  };

  action "login" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: {} }
  };

  action "logout" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: {} }
  };
}
`

const EVENT_SCHEMA = `
decision event <A>::request {
  ...inputs(A),
}

event <A>::response {
  ...inputs(A),
}
`

describe('DogwoodAuthorization', () => {
  describe('real Dogwood evaluation', () => {
    it('allows permitted tool calls', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        actionSchema: ACTION_SCHEMA,
      })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      const result = await agent.invoke('Search')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it('denies tools not in any permit policy (default-deny)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_record', toolUseId: 'tool-1', input: { id: '1' } })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      let toolExecuted = false
      const tool = createMockTool('delete_record', () => {
        toolExecuted = true
        return 'deleted'
      })

      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        actionSchema: ACTION_SCHEMA,
      })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await agent.invoke('Delete it')

      expect(toolExecuted).toBe(false)
    })

    it('enforces role-based access (admin can delete, analyst cannot)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_record', toolUseId: 'tool-1', input: { id: '1' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('delete_record', () => {
        toolExecuted = true
        return 'deleted'
      })

      const dogwood = new DogwoodAuthorization({
        policies: `${FIXTURES}/role-based.dogwood`,
        actionSchema: ACTION_SCHEMA,
        principalResolver: (state) => {
          if (!state.user_id) return undefined
          return { type: 'User', id: String(state.user_id) }
        },
        entityResolver: (state) => [
          { type: 'User', id: String(state.user_id), attrs: { role: String(state.role) } },
          { type: 'Resource', id: 'agent' },
        ],
      })

      // Admin can delete
      const adminAgent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await adminAgent.invoke('Delete it', {
        invocationState: { user_id: 'alice', role: 'admin' },
      })
      expect(toolExecuted).toBe(true)

      // Reset for next test
      toolExecuted = false
      dogwood.reset()

      // Analyst cannot delete
      const model2 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'delete_record', toolUseId: 'tool-2', input: { id: '2' } })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      const analystAgent = new Agent({ model: model2, tools: [tool], interventions: [dogwood], printer: false })
      await analystAgent.invoke('Delete it', {
        invocationState: { user_id: 'bob', role: 'analyst' },
      })
      expect(toolExecuted).toBe(false)
    })
  })

  describe('temporal policies', () => {
    it('enforces login-before-read gate via temporal since operator', async () => {
      const dogwood = new DogwoodAuthorization({
        policies: `${FIXTURES}/login-gate.dogwood`,
        actionSchema: NAMESPACED_ACTION_SCHEMA,
        eventSchema: EVENT_SCHEMA,
      })

      let readExecuted = false
      const readTool = createMockTool('read_data', () => {
        readExecuted = true
        return 'data'
      })
      const loginTool = createMockTool('login', () => 'logged in')
      const tools = [readTool, loginTool]

      // Read before login — denied
      const model1 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'read_data', toolUseId: 'tool-1', input: { document: 'doc1' } })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      const agent1 = new Agent({ model: model1, tools, interventions: [dogwood], printer: false })
      await agent1.invoke('Read data')
      expect(readExecuted).toBe(false)

      // Login
      const model2 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'login', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Logged in' })

      const agent2 = new Agent({ model: model2, tools, interventions: [dogwood], printer: false })
      await agent2.invoke('Login')

      // Read after login — allowed
      readExecuted = false
      const model3 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'read_data', toolUseId: 'tool-3', input: { document: 'doc2' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent3 = new Agent({ model: model3, tools, interventions: [dogwood], printer: false })
      await agent3.invoke('Read data')
      expect(readExecuted).toBe(true)
    })

    it('reset() clears temporal state', async () => {
      const dogwood = new DogwoodAuthorization({
        policies: `${FIXTURES}/login-gate.dogwood`,
        actionSchema: NAMESPACED_ACTION_SCHEMA,
        eventSchema: EVENT_SCHEMA,
      })

      const loginTool = createMockTool('login', () => 'logged in')
      let readExecuted = false
      const readTool = createMockTool('read_data', () => {
        readExecuted = true
        return 'data'
      })
      const tools = [loginTool, readTool]

      // Login
      const model1 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'login', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'ok' })
      const agent1 = new Agent({ model: model1, tools, interventions: [dogwood], printer: false })
      await agent1.invoke('Login')

      expect(dogwood.decisionCount).toBeGreaterThan(0)

      // Reset clears temporal state
      dogwood.reset()
      expect(dogwood.decisionCount).toBe(0)

      // Read after reset (no login) — denied again
      const model2 = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'read_data', toolUseId: 'tool-2', input: { document: 'doc' } })
        .addTurn({ type: 'textBlock', text: 'Ok' })
      const agent2 = new Agent({ model: model2, tools, interventions: [dogwood], printer: false })
      await agent2.invoke('Read')
      expect(readExecuted).toBe(false)
    })
  })

  describe('principal config', () => {
    it('supports static principal', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        actionSchema: ACTION_SCHEMA,
        principal: { type: 'User', id: 'alice' },
      })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await agent.invoke('Search')
      expect(toolExecuted).toBe(true)
    })

    it('throws when both principal and principalResolver are provided', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action, resource);',
            actionSchema: ACTION_SCHEMA,
            principal: { type: 'User', id: 'alice' },
            principalResolver: () => ({ type: 'User', id: 'bob' }),
          })
      ).toThrow('Provide either `principal` or `principalResolver`, not both')
    })

    it('defaults to anonymous principal', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        actionSchema: ACTION_SCHEMA,
      })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await agent.invoke('Search')
      expect(toolExecuted).toBe(true)
    })

    it('denies when principalResolver returns undefined (fail-closed)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Ok' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
        principalResolver: () => undefined,
      })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await agent.invoke('Search')
      expect(toolExecuted).toBe(false)
    })
  })

  describe('construction validation', () => {
    it('throws on malformed policy', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'not valid dogwood {{{ garbage',
            actionSchema: ACTION_SCHEMA,
          })
      ).toThrow('Invalid Dogwood policy')
    })

    it('throws when neither actionSchema nor tools provided', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action, resource);',
          })
      ).toThrow('Provide either `actionSchema` or `tools`')
    })

    it('accepts valid policies without errors', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action, resource);',
            actionSchema: ACTION_SCHEMA,
          })
      ).not.toThrow()
    })
  })

  describe('onError behavior', () => {
    it('throws by default when handler errors', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
      })

      expect(dogwood.onError).toBe('throw')
    })

    it('respects deny onError setting', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
        onError: 'deny',
      })

      expect(dogwood.onError).toBe('deny')
    })

    it('respects proceed onError setting', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
        onError: 'proceed',
      })

      expect(dogwood.onError).toBe('proceed')
    })
  })

  describe('file-based config', () => {
    it('reads .dogwood policy file from disk', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const dogwood = new DogwoodAuthorization({
        policies: `${FIXTURES}/permit-search.dogwood`,
        actionSchema: ACTION_SCHEMA,
      })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await agent.invoke('Search')
      expect(toolExecuted).toBe(true)
    })

    it('reads .cedarschema file from disk', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action, resource);',
            actionSchema: `${FIXTURES}/test-action.cedarschema`,
          })
      ).not.toThrow()
    })

    it('throws when .dogwood file does not exist', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `${FIXTURES}/nonexistent.dogwood`,
            actionSchema: ACTION_SCHEMA,
          })
      ).toThrow('Dogwood policy file not found')
    })

    it('throws when .cedarschema file does not exist', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action, resource);',
            actionSchema: `${FIXTURES}/nonexistent.cedarschema`,
          })
      ).toThrow('Cedar action schema file not found')
    })
  })

  describe('reload', () => {
    it('recreates authorizer and discards temporal state', async () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
        eventSchema: EVENT_SCHEMA,
      })

      const tool = createMockTool('search', () => 'results')
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await agent.invoke('Search')
      expect(dogwood.decisionCount).toBeGreaterThan(0)

      dogwood.reload()
      expect(dogwood.decisionCount).toBe(0)
    })
  })

  describe('accessors', () => {
    it('exposes actions from the authorizer', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
      })

      expect(dogwood.actions).toBeInstanceOf(Array)
      expect(dogwood.actions.length).toBeGreaterThan(0)
    })

    it('exposes decisionCount', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
      })

      expect(dogwood.decisionCount).toBe(0)
    })

    it('exposes decisionKinds when event schema provided', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        actionSchema: ACTION_SCHEMA,
        eventSchema: EVENT_SCHEMA,
      })

      expect(dogwood.decisionKinds).toBeInstanceOf(Array)
      expect(dogwood.decisionKinds).toContain('request')
    })
  })

  describe('schema generation from tools', () => {
    it('auto-generates action schema when tools provided', () => {
      const tools = [
        { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'delete', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      ]

      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action, resource);',
            tools,
          })
      ).not.toThrow()
    })

    it('allows tool calls with auto-generated schema', async () => {
      const tools = [
        {
          name: 'search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          description: 'Search for things',
        },
      ]

      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action, resource);',
        tools,
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const mockTool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const agent = new Agent({ model, tools: [mockTool], interventions: [dogwood], printer: false })
      await agent.invoke('Search')
      expect(toolExecuted).toBe(true)
    })
  })

  describe('context enricher', () => {
    it('passes enricher context to evaluation', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('search', () => {
        toolExecuted = true
        return 'results'
      })

      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action == Action::"search", resource);',
        actionSchema: ACTION_SCHEMA,
        contextEnricher: () => ({
          session: { environment: 'test' },
        }),
      })

      const agent = new Agent({ model, tools: [tool], interventions: [dogwood], printer: false })
      await agent.invoke('Search')
      expect(toolExecuted).toBe(true)
    })
  })
})
