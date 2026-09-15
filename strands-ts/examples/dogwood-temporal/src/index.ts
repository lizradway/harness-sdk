/**
 * Dogwood Temporal Authorization Demo
 *
 * Demonstrates temporal policy enforcement with Strands agents using the
 * Dogwood policy language. Shows how the `since` operator creates session-aware
 * access gates — a tool is only allowed after a prior event (login) and revoked
 * by another (logout), all enforced by a stateful policy engine.
 *
 * Usage:
 *   npm start
 *
 * Requires:
 *   - AWS credentials configured for Bedrock access
 */

import { Agent, BedrockModel, tool } from '@strands-agents/sdk'
import { DogwoodAuthorization } from '@strands-agents/sdk/vended-interventions/dogwood'

// ── ANSI helpers ───────────────────────────────────────────────────────

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const MAGENTA = '\x1b[35m'

function banner(text: string): void {
  const line = '─'.repeat(60)
  console.log(`\n${CYAN}${line}${RESET}`)
  console.log(`${BOLD}${CYAN}  ${text}${RESET}`)
  console.log(`${CYAN}${line}${RESET}\n`)
}

function step(label: string): void {
  console.log(`${MAGENTA}▸ ${label}${RESET}`)
}

function allowed(toolName: string): void {
  console.log(`  ${GREEN}✔ ${toolName}${RESET} ${DIM}— allowed${RESET}`)
}

function denied(toolName: string): void {
  console.log(`  ${RED}✘ ${toolName}${RESET} ${DIM}— denied by temporal policy${RESET}`)
}

function info(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`)
}

function state(dogwood: DogwoodAuthorization): void {
  console.log(`  ${YELLOW}⟳ temporal state: ${dogwood.decisionCount} decisions recorded${RESET}`)
}

// ── Schemas ────────────────────────────────────────────────────────────

const ACTION_SCHEMA = `
namespace Demo {
  entity User;
  entity Resource;

  action "login" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: {} }
  };

  action "logout" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: {} }
  };

  action "search_documents" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: { query: String } }
  };

  action "read_document" appliesTo {
    principal: [User], resource: [Resource],
    context: { input: { document_id: String } }
  };

  action "list_users" appliesTo {
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

const POLICIES = `
// Login and logout are always permitted
permit(principal, action == Demo::Action::"login", resource);
permit(principal, action == Demo::Action::"logout", resource);

// Data-access tools require an active session:
// allowed only if a login happened, with no logout since
permit(principal, action == Demo::Action::"search_documents", resource)
when temporal {
  !(Demo::Action::"logout"::request{ })
    since within 1h
  Demo::Action::"login"::request{ }
};

permit(principal, action == Demo::Action::"read_document", resource)
when temporal {
  !(Demo::Action::"logout"::request{ })
    since within 1h
  Demo::Action::"login"::request{ }
};

permit(principal, action == Demo::Action::"list_users", resource)
when temporal {
  !(Demo::Action::"logout"::request{ })
    since within 1h
  Demo::Action::"login"::request{ }
};
`

// ── Tools ──────────────────────────────────────────────────────────────

const loginTool = tool({
  name: 'login',
  description: 'Log in to the system. Must be called before accessing any data.',
  callback: () => 'Session started. You now have access to data tools.',
})

const logoutTool = tool({
  name: 'logout',
  description: 'Log out of the system. Revokes access to data tools.',
  callback: () => 'Session ended. Data access has been revoked.',
})

const searchDocumentsTool = tool({
  name: 'search_documents',
  description: 'Search the document database.',
  inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] },
  callback: (input) => {
    const { query } = input as { query: string }
    return JSON.stringify({
      results: [
        { id: 'DOC-001', title: `Report on ${query}`, date: '2025-03-15' },
        { id: 'DOC-002', title: `Analysis: ${query}`, date: '2025-04-01' },
      ],
    })
  },
})

const readDocumentTool = tool({
  name: 'read_document',
  description: 'Read a specific document by ID.',
  inputSchema: {
    type: 'object' as const,
    properties: { document_id: { type: 'string' } },
    required: ['document_id'],
  },
  callback: (input) => {
    const { document_id } = input as { document_id: string }
    return `Document ${document_id}: [Confidential content — quarterly projections and strategy notes]`
  },
})

const listUsersTool = tool({
  name: 'list_users',
  description: 'List all users in the system.',
  callback: () => {
    return JSON.stringify({
      users: [
        { id: 'U1', name: 'Alice', role: 'admin' },
        { id: 'U2', name: 'Bob', role: 'analyst' },
        { id: 'U3', name: 'Eve', role: 'viewer' },
      ],
    })
  },
})

const allTools = [loginTool, logoutTool, searchDocumentsTool, readDocumentTool, listUsersTool]

const SYSTEM_PROMPT = [
  'You are a helpful assistant with access to a document system.',
  'Tools available: login, logout, search_documents, read_document, list_users.',
  'IMPORTANT: Always use the tools when asked. Follow instructions exactly.',
  'Do NOT explain that you need to login — just try the tool the user asked for.',
  'Keep responses very short — one sentence max.',
].join(' ')

// ── Demo scenarios ─────────────────────────────────────────────────────

async function runDemo(): Promise<void> {
  banner('Dogwood Temporal Authorization Demo')

  info('Policy: data-access tools (search, read, list) require an active login session.')
  info('The Dogwood temporal engine tracks login/logout events automatically —')
  info('no manual session state or call-count tracking needed.\n')

  const dogwood = new DogwoodAuthorization({
    policies: POLICIES,
    actionSchema: ACTION_SCHEMA,
    eventSchema: EVENT_SCHEMA,
    principal: { type: 'Demo::User', id: 'alice' },
  })

  const model = new BedrockModel({ modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0' })

  // Each scenario gets a fresh agent to avoid conversation history buildup,
  // but they all share the same `dogwood` handler — its temporal state persists.
  function freshAgent(): Agent {
    return new Agent({
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: allTools,
      interventions: [dogwood],
      printer: false,
    })
  }

  // ── Scenario 1: Try to access data before login ──────────────────

  banner('Scenario 1: Access Before Login')
  step('Asking agent to search documents (no active session)')
  info('Expected: DENIED — no login event in temporal history\n')

  await freshAgent().invoke('Search for "quarterly report" using the search_documents tool.')
  state(dogwood)
  denied('search_documents')
  console.log()

  // ── Scenario 2: Login then access data ───────────────────────────

  banner('Scenario 2: Login Then Access')
  step('Asking agent to login')

  await freshAgent().invoke('Use the login tool to log in.')
  state(dogwood)
  allowed('login')
  console.log()

  step('Now searching documents (session active)')
  info('Expected: ALLOWED — login event is in temporal history\n')

  await freshAgent().invoke('Search for "quarterly report" using the search_documents tool.')
  state(dogwood)
  allowed('search_documents')
  console.log()

  step('Reading a specific document')
  await freshAgent().invoke('Read document DOC-001 using the read_document tool.')
  state(dogwood)
  allowed('read_document')
  console.log()

  // ── Scenario 3: Logout revokes access ────────────────────────────

  banner('Scenario 3: Logout Revokes Access')
  step('Asking agent to logout')

  await freshAgent().invoke('Use the logout tool to log out.')
  state(dogwood)
  info('Session ended\n')

  step('Trying to list users after logout')
  info('Expected: DENIED — logout event cancels the login gate\n')

  await freshAgent().invoke('Use the list_users tool to list all users.')
  state(dogwood)
  denied('list_users')
  console.log()

  // ── Scenario 4: Re-login restores access ─────────────────────────

  banner('Scenario 4: Re-login Restores Access')
  step('Logging in again')

  await freshAgent().invoke('Use the login tool to log in again.')
  state(dogwood)
  allowed('login')
  console.log()

  step('Listing users after re-login')
  info('Expected: ALLOWED — fresh login event reactivates the gate\n')

  await freshAgent().invoke('Use the list_users tool.')
  state(dogwood)
  allowed('list_users')
  console.log()

  // ── Scenario 5: Reset clears all temporal state ──────────────────

  banner('Scenario 5: Reset Temporal State')
  info(`Decisions before reset: ${dogwood.decisionCount}`)
  step('Calling dogwood.reset() — all temporal history is cleared\n')
  dogwood.reset()
  info(`Decisions after reset: ${dogwood.decisionCount}`)
  console.log()

  step('Trying to search after reset (no login in history)')
  info('Expected: DENIED — reset wiped the login event\n')

  await freshAgent().invoke('Search for "budget" using the search_documents tool.')
  state(dogwood)
  denied('search_documents')

  // ── Summary ──────────────────────────────────────────────────────

  banner('Summary')
  console.log(`  ${BOLD}Dogwood temporal policies enabled:${RESET}`)
  console.log(`    ${GREEN}✔${RESET} Session-gated access (login before data tools)`)
  console.log(`    ${GREEN}✔${RESET} Automatic session revocation (logout cancels gate)`)
  console.log(`    ${GREEN}✔${RESET} Stateful enforcement (no manual session tracking)`)
  console.log(`    ${GREEN}✔${RESET} Full state reset capability`)
  console.log()
  console.log(`  ${DIM}Total decisions rendered: ${dogwood.decisionCount}${RESET}`)
  console.log(`  ${DIM}Declared actions: ${dogwood.actions.join(', ')}${RESET}`)
  console.log(`  ${DIM}Decision kinds: ${dogwood.decisionKinds.join(', ')}${RESET}`)
  console.log()
}

await runDemo().catch(console.error)
