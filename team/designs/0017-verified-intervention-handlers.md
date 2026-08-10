# Vigil: Dogwood Policy Intervention Handler

**Status**: Proposed

**Date**: 2026-07-29

**Issue**: TBD

---

<details>
<summary><strong>Definitions</strong></summary>

| Term | Definition |
|------|-----------|
| **Intervention Handler** | The Strands SDK's first-class control primitive (design 0007). Intercepts lifecycle events, evaluates against rules, returns Proceed/Deny/Guide/Transform/Confirm. |
| **Dogwood** | Cedar extended with bounded past-time Metric First-Order Temporal Logic (MFOTL). Adds `formerly`, `previous`, `since` operators and aggregations (`count`, `sum`) over event history. The temporal policy language for trajectory-aware constraints. Open source at [github.com/dogwood-policy/dogwood](https://github.com/dogwood-policy/dogwood). |
| **Temporal monitor** | A state machine that advances over an event stream, evaluating temporal properties in real-time. Each event updates the monitor's state; queries resolve against the accumulated history. |
| **Trajectory-aware constraint** | A constraint whose evaluation depends on what already happened in the current execution — prerequisites, loops, cascades, budgets. Requires temporal operators over event history, not just the current request. |

</details>

---

[Problem](#problem) · [Goals and Non-Goals](#goals-and-non-goals) · [Proposal](#proposal) · [Dogwood as Constraint Language](#dogwood-as-constraint-language) · [Developer Experience](#developer-experience) · [Consequences](#consequences)

---

## Problem

Agents fail in ways you can't predict. They call a payment API without authentication, loop on an expensive tool 47 times, deploy without a health check, hit a rate limit on the fourth call. The consequences are expensive and often irreversible.

The core problem isn't that agents make mistakes — it's that **constraints resist enumeration**. You can't write rules for things you don't know about yet.

### Constraints are latent

Every static approach — system prompts, Cedar policies, guardrail configs — assumes you already know the constraints. But in practice, most constraints are implicit. They exist in the system's behavior, not in any document:

- The 403 on `charge` without `authenticate` isn't documented anywhere. It just happens.
- The rate limit on the payments API isn't in the tool description. You discover it on the fourth call.
- The deployment pipeline requires health-check → promote ordering. No schema says so.
- The third-party API silently corrupts data if you call `update` before `refresh`. You learn this from a production incident.

This is the ICRL insight [14]: constraints are latent in the environment. You can't enumerate them upfront because you don't know what they are until you hit them.

### Remembering isn't enforcing

Memory systems solve knowledge propagation — Agent A learns that `charge` requires `authenticate`, and memory can surface that to Agent B. But a remembered constraint is just a more sophisticated system prompt. It's still advisory: the model can ignore it under pressure, adversarial prompts can override it, and you can't audit or test compliance.

The gap isn't remembering constraints — it's enforcing them. A constraint in memory says "you should authenticate first." A constraint in Vigil says "this call will not execute until authenticate has completed." One is guidance; the other is a gate.

### Enforcement must be deterministic

Once you know a constraint — whether authored or discovered — you need a gate the model cannot circumvent. Putting constraints in the prompt (or memory, or system instructions) is fundamentally insufficient. This is not a model quality problem — it's architectural:

- **Safety competes with the task.** The model weighs "don't call charge without auth" against "process this payment urgently." Under pressure, the task wins. Agent-C [1] demonstrated 100% conformance with deterministic enforcement vs 77.4% with the model self-policing. That's a 22.6% failure rate on known constraints that were explicitly stated in the prompt.
- **Prompts don't scale.** Three constraints fit in a system prompt. Fifty don't. Each competes for attention with the actual task. In long-running agents already fighting context limits, packing safety rules into the prompt directly competes with the agent's ability to remember what it's doing. Every constraint you add dilutes the attention available for every other constraint.
- **Self-monitoring is unreliable.** A model that could reliably detect its own violations wouldn't commit them. The LLM-Modulo framework [13] formalizes this: LLMs are "universal approximate knowledge sources" — they know things about the world, but cannot certify facts about their own outputs. They are generators, not verifiers. Asking a model to verify its own output is infinite regress.
- **You can't audit or test a prompt.** "Prove no deployment skipped a health check this month." With a prompt, you can't — the model might have followed the instruction or might not have. With a deterministic gate, enforcement is binary: if the constraint existed, the call was blocked. Period. `expect(tool).toHaveBeenBlocked()`.
- **Constraints are model-portable.** Switch from Claude to GPT to Llama, and every prompt-based rule needs re-testing. A deterministic gate doesn't care which model is generating the calls — it evaluates the same way regardless.

### The problem, stated simply

**How do you go from zero authored policies to a set of enforced constraints that prevent the failures you've already seen — without requiring a human to write each rule?**

This requires three things working together:

1. **Discovery** — observe failures and infer what constraint was violated
2. **Enforcement** — evaluate constraints deterministically, in microseconds, no LLM in the path
3. **Transfer** — propagate discovered constraints to new agents so they never hit the same failure

This is what Vigil does. Failures become constraints, constraints become enforcement, enforcement transfers across agents. The authored-policy path exists (and is the right choice when you know your constraints), but the novel contribution is closing the loop from observed failure → deterministic prevention automatically.

---

## Goals and Non-Goals

### Goals

1. **Dynamic constraint discovery**: discover Dogwood constraints from observed failure patterns — no manual rule authoring required. Failures become policies automatically.
2. **Same-session enforcement**: discovered constraints begin enforcing within the same session. No redeploy, no restart.
3. **Cross-agent transfer**: persist discovered constraints to storage so new agents inherit protection without ever seeing a failure.
4. **Deterministic enforcement**: no LLM in `beforeToolCall`. Compiled Dogwood evaluates as set lookups and counter checks (microseconds).
5. **Authored policy support**: also works with purely human-written Dogwood policies (zero discovery) for known constraints.
6. **Composition**: standard intervention pipeline — composes with Cedar, RiskGate, steering, HITL.

### Non-Goals

- Replacing Cedar for identity/permission checks.
- Replacing authored Dogwood for infrastructure-level enforcement (Vigil is inside the loop, not at the gateway).
- Replacing RiskGate for risk classification and HITL escalation.
- Implementing a full Dogwood runtime in TypeScript (use the WASM module when available; compiled typed JSON handles common cases).
- Offline trace analysis or log processing (the monitor operates over the live event stream, not stored traces).
- Real-time LLM-based enforcement (too slow, non-deterministic, bypassable).
- Formal verification of the learning system itself (discovery is statistical, not formally verified).
- Python SDK implementation (follow-up).

---

## Proposal

### Core concept: a Dogwood policy handler with optional discovery

Vigil is a Dogwood policy intervention handler — the temporal counterpart to `CedarAuthorization`. It evaluates Dogwood temporal policies against the agent's execution trajectory on every `beforeToolCall`. Like Cedar, it can work with purely authored policies. Unlike Cedar, it can optionally discover new policies from the agent's own execution.

```typescript
// Authored policies only (like CedarAuthorization but temporal)
const vigil = new Vigil({
  policies: `
    forbid(principal, action == Action::"charge", resource)
    unless temporal { formerly Action::"authenticate"::request };
  `,
})

// Same handler, discovery enabled
const vigil = new Vigil({
  policies: '...', // optional starting policies
  discover: true,
  storage,
})
```

| Mode | What it does | LLM needed? |
|------|-------------|-------------|
| **Enforce only** | Evaluate authored Dogwood policies against trajectory | No |
| **Discover + enforce** | Observe execution, discover new policies, enforce all | Discovery: optional. Enforcement: never. |

The handler advances over the agent's event stream — every `beforeToolCall` evaluates policies against the trajectory so far, every `afterToolCall` records the outcome into the trajectory.

```
beforeToolCall → evaluate Dogwood policies against trajectory → proceed/deny
afterToolCall  → update trajectory (+ detect patterns if discover: true)
```

The "trajectory" is a Set of completed tools + a Map of call counts + a Set of failed tools. It lives in memory for the duration of the agent's execution. The context window IS the execution history.

### Vigil

A single `InterventionHandler` with two responsibilities:

**Always (enforcement):**
1. **Evaluates** Dogwood policies against the current trajectory on every `beforeToolCall`
2. **Records** tool outcomes into the trajectory on every `afterToolCall`
3. **Denies** calls that violate temporal constraints deterministically

**When `discover: true` (optional):**
4. **Discovers** new constraint patterns from observed failures (statistical pattern matching)
5. **Validates** discoveries against evidence thresholds before enforcing
6. **Persists** discovered constraints to storage for cross-agent transfer
7. **Self-corrects** — demotes constraints that humans consistently override

### What it discovers

| Pattern | Signal | Dogwood policy | Compiled form |
|---------|--------|----------------|---------------|
| **Authorization** | Tool always fails for this principal/resource | `forbid(principal, action == Action::"X", resource)` | `{ type: 'forbid', tool, principal?, resource? }` |
| **Prerequisites** | Tool B fails without A; succeeds with A | `forbid ... unless temporal { formerly Action::"A"::request }` | `{ type: 'requires', tool, condition }` |
| **Loops** | Same tool + same args repeated | `forbid ... when temporal { count(same input) >= N }` | `{ type: 'loop', tool, maxRepeats }` |
| **Cascades** | When A fails, B always fails after | `forbid ... when temporal { formerly A::resolution{error} }` | `{ type: 'cascade', trigger, blocks }` |
| **Budgets** | Tool exceeds max calls | `forbid ... when temporal { count(...) >= N }` | `{ type: 'budget', tool, maxCalls }` |

Dogwood is a superset of Cedar — stateless authorization is just the degenerate case where no temporal operators are needed. Vigil discovers both: a tool that always fails regardless of context is an authz constraint; a tool that fails only without a prerequisite is temporal. Every discovered constraint is compiled to a typed JSON form that evaluates as a set membership check or counter comparison — microseconds, no ambiguity.

### How discovery works

Pattern detection runs after every observation as part of event processing. No LLM call. Discovers the common temporal patterns (prerequisites, loops, cascades, budgets) from the observation buffer:

```
Call 1: charge() → 403          → observe(failure, precedingTools: [])
Call 2: authenticate() → ok     → observe(success)
Call 3: charge() → 403          → observe(failure, precedingTools: [])  
Call 4: authenticate() → ok     → observe(success)
Call 5: charge() → ok           → observe(success, precedingTools: [authenticate])
                                  → DISCOVER: charge requires authenticate
                                    (3 failures without + 1 success with = causal evidence)
Call 6: charge() → DENIED       → constraint enforcing
```

Future: LLM-assisted discovery could analyze failure patterns and propose constraints that statistical detection misses (error message interpretation, domain-specific rules). Every proposal would pass through the same validation pipeline — the LLM proposes, the monitor validates.

### Validation before enforcement

A discovered constraint must pass:

1. **Minimum evidence** — enough observations to be statistically meaningful (configurable, default 3)
2. **Causal confirmation** — at least one success where the proposed condition was met
3. **Consistency check** — no circular dependencies ("A requires B" + "B requires A")
4. **Canary period** — optional shadow mode (default: 0, immediate enforcement)

### Self-correction and demotion

If humans override a denial more than a threshold percentage, the constraint demotes:

| Tier | Action | Semantics |
|------|--------|-----------|
| **Enforced** | `deny()` | Invariant — always true |
| **Advisory** | `guide()` | Usually true but exceptions exist |
| **Retired** | no-op | Pattern isn't reliable |

"Authenticate before charge" is invariant. "Run tests before deploy" is contextual (valid to skip for a hotfix). The first stays enforced; the second demotes to advisory.

---

## Dogwood as Constraint Language

Vigil evaluates **Dogwood** policies — the same way CedarAuthorization evaluates Cedar policies. Every policy, whether authored by a developer or discovered from execution, is a Dogwood temporal policy.

### Why Dogwood

Cedar answers "is this principal allowed to perform this action?" — a stateless, per-request question. Agent safety requires "is it safe to perform this action *given what already happened*?" This is inherently temporal. Dogwood extends Cedar with the operators needed:

| Operator | Semantics | Maps to |
|----------|-----------|---------|
| `formerly within W` | Some matching event occurred within window W | Prerequisites |
| `count(...)` | Aggregate count of matching events | Budgets |
| `previous` | The immediately preceding event | Loop detection |
| `since` | Property held continuously since condition | Cascades |

### Dogwood event model

Dogwood's two event kinds map directly to agent lifecycle hooks:

| Dogwood concept | Agent hook | Role |
|-----------------|-----------|------|
| `request` | `beforeToolCall` | Decision point — triggers authorization |
| `resolution` | `afterToolCall` | History-only — records outcome for temporal queries |

A tool call generates a `request` (authz decision), then a `resolution` (outcome recording). Temporal operators query the history of both.

### Constraint types as Dogwood policies

**Prerequisites** — `charge` requires prior `authenticate`:

```cedar
forbid(principal, action == Action::"charge", resource)
unless temporal {
  formerly Action::"authenticate"::request{
    __cedar_principal: principal
  }
};
```

**Budgets** — max 3 charges per session:

```cedar
forbid(principal, action == Action::"charge", resource)
when temporal {
  count(Action::"charge"::request{__cedar_principal: principal}) >= 3
};
```

**Cascades** — block `promote` after `deploy` failure:

```cedar
forbid(principal, action == Action::"promote", resource)
when temporal {
  formerly Action::"deploy"::resolution{
    __cedar_principal: principal,
    output.error: true
  }
};
```

**Loops** — block repeated identical calls:

```cedar
forbid(principal, action == Action::"search", resource)
when temporal {
  count(Action::"search"::request{
    __cedar_principal: principal,
    input: context.input
  }) >= 5
};
```

### Compiled form

The typed JSON IS compiled Dogwood — `requires` is compiled `formerly`, `budget` is compiled `count`. The monitor discovers constraints and produces the compiled form directly. Dogwood text is the canonical representation for auditing and sharing.

### Relationship to Cedar

| Layer | Language | Statefulness |
|-------|----------|-------------|
| Identity/authz | Cedar | Stateless per-request |
| Trajectory constraints | Dogwood | Stateful over event history |
| Infrastructure perimeter | Dogwood | Stateful over event history |

Cedar handles "who can call what." Dogwood handles "when is it safe to call, given history." Same language at every temporal layer.

---

## Developer Experience

### Authored policies (like CedarAuthorization)

```typescript
import { Agent } from '@strands-agents/sdk'
import { Vigil } from '@strands-agents/sdk/vended-interventions/vigil'

const vigil = new Vigil({
  policies: `
    forbid(principal, action == Action::"charge", resource)
    unless temporal { formerly Action::"authenticate"::request };

    forbid(principal, action == Action::"charge", resource)
    when temporal { count(Action::"charge"::request) >= 5 };
  `,
})

const agent = new Agent({
  tools: [authenticate, charge, refund],
  interventions: [vigil],
})
```

Pure enforcement. No discovery. Temporal policies evaluate deterministically against the execution trajectory.

### With discovery enabled

```typescript
const vigil = new Vigil({
  discover: true,
  storage: new DynamoDBStorage({ table: 'agent-governance' }),
})

const agent = new Agent({
  tools: [authenticate, charge, refund],
  interventions: [vigil],
})

// The handler watches, discovers, and enforces — all inline:
// charge() fails without auth → evidence accumulates → constraint discovered → subsequent charge() DENIED
// Discovered constraints persist to storage → next agent loads them on startup
```

### Both: authored + discovery

```typescript
const vigil = new Vigil({
  policies: `
    forbid(principal, action == Action::"promote", resource)
    unless temporal { formerly Action::"health_check"::request };
  `,
  discover: true,
  storage,
})
```

Authored policies enforce immediately. Discovery finds additional constraints from execution. Both coexist.

### Composition

```typescript
const agent = new Agent({
  tools: [...],
  interventions: [
    cedarAuth,      // WHO can call (identity)
    riskGate,       // WHAT risk level (classification + HITL)
    vigil,          // WHEN is it safe (temporal constraints)
  ],
})
```

Each answers a distinct question. The pipeline short-circuits — if Cedar denies, nothing else fires.

### Inspection

```typescript
vigil.getEnforcingConstraints()
// [{ constraint: { type: 'requires', tool: 'charge', condition: 'authenticate' },
//    status: 'enforcing', evidence: { failures: 4, successes: 2, overrides: 0 },
//    source: 'discovered' }]
```

---

## Consequences

### What becomes easier

- **Temporal enforcement as an SDK primitive.** Dogwood policies inside the agent loop, just like Cedar for authz. `interventions: [vigil]`.
- **Microsecond enforcement.** Compiled Dogwood evaluates as set lookups. No LLM, no latency, no token cost.
- **Auditable.** Every denial has a reason, a Dogwood policy text, and provenance.
- **Immune to prompt injection.** Enforcement is code. Adversarial messages cannot override.
- **Discovery closes the authoring loop.** With `discover: true`, the handler finds constraints you didn't know existed — from the agent's own execution.
- **Institutional memory.** Discovered constraints persist. One agent's failures protect all future agents.
- **Self-correcting.** Constraints that humans override demote rather than accumulate.

### What requires care

- **Discovery needs failures.** Cannot prevent the *first* occurrence. For known risks, author Dogwood policies.
- **Discovered constraints may be wrong.** Validation mitigates but doesn't eliminate this. Review discoveries for safety-critical tools.
- **Cold start.** A fresh handler with no policies and no storage enforces nothing. Author policies or pre-seed storage.
- **Storage for cross-agent transfer.** In-memory mode works for single-agent use but doesn't survive restarts.

---

## Empirical Results

Tested with a simulated agent calling `charge` without `authenticate` (prerequisite violation), 30 invocations across 6 batches:

| Batch | Failures | Blocked | Failure Rate |
|-------|----------|---------|--------------|
| 1 (learning) | 4 | 0 | 80% |
| 2–6 (enforcing) | 0 | 20 | 0% |

**Post-discovery failure rate: 0%.** Convergence: one batch of failures + one success with the prerequisite present.

| Mode | Failures | Rate |
|------|----------|------|
| No guard | 5/5 | 100% |
| Vigil | 4/30 | 13% overall, 0% post-discovery |
| Manual constraints | 0/5 | 0% |

Cross-agent transfer eliminates cold start: the second guard instance loading from the same storage has zero failures from its first call.

---

<details>
<summary><strong>Appendix A: Discovery Algorithm</strong></summary>

### Observation

On every `afterToolCall`: tool name, args hash, success/failure, error, preceding tools in this invocation. This is the monitor advancing its state.

### Statistical discovery (inline, default)

After each observation, the monitor checks for discoverable patterns:

- **Prerequisites**: tool B fails without tool A; succeeds with tool A → `requires` constraint
- **Loops**: same tool + same args repeated beyond threshold → `loop` constraint  
- **Cascades**: when tool A fails, tool B always fails after → `cascade` constraint

Pure pattern matching over the observation buffer. Constraints that meet the evidence threshold begin enforcing immediately.

### Validation

Before a constraint enforces:

1. **Evidence threshold**: at least N failures (default 3)
2. **Causal confirmation**: at least one success where the condition was met
3. **Consistency**: no circular dependencies
4. **Canary** (optional): shadow-mode for M invocations before blocking

### Enforcement

```typescript
// Set membership — microseconds
if (constraint.type === 'requires' && !completedTools.has(condition)) {
  return deny(`requires: ${condition}`)
}

// Counter check — microseconds
if (constraint.type === 'loop' && repeats >= maxRepeats) {
  return deny(`loop: ${tool} called ${repeats} times`)
}
```

</details>

---

<details>
<summary><strong>Appendix B: Research Landscape and Prior Art</strong></summary>

The research converges from multiple directions on the same architecture: **observe execution, discover temporal constraints, enforce deterministically.**

| Field | Key work | Contribution | Online/Offline |
|-------|----------|-------------|----------------|
| **Specification mining** | Ammons et al. (POPL 2002) | Mine API usage protocols (FSMs) from method call traces | Offline |
| **Invariant detection** | Ernst et al. (Daikon, 2001) | Discover likely program invariants from execution traces | Offline |
| **Process mining** | Declare Miner (Maggi et al., 2012) | Mine LTLf temporal constraints from event logs | Offline |
| **Declare monitoring** | De Giacomo et al. (2014) | Advance LTLf automata over live event streams | Online |
| **Structural repair** | ANNEAL (Hakim et al., 2026) | Install symbolic patches from failures; 72-100% → 0% recurrence | Online |
| **Adaptive guardrails** | AGrail (Luo et al., 2025) | Test-time adaptation; 99.1% vs 95.6% without | Online |
| **Inverse constraint RL** | Malik et al. (ICML 2021) | Infer constraints from safe/unsafe demonstrations | Offline |
| **Harness engineering** | arXiv 2607.08028 (2026) | Deterministic enforcement around neural components | — |
| **LLM-Modulo** | Kambhampati et al. (ICML 2024) | LLMs generate; external verifiers certify | — |

Vigil's lineage is most directly Declare monitoring (temporal monitor over event stream) + Declare mining (discover constraints from observed patterns) + ANNEAL (structural repair — discovered constraints prevent recurrence).

### The Declare Miner parallel

The Declare Miner counts **activations** (tool called) and **fulfillments** (prerequisite met) vs **violations** (prerequisite absent), computes confidence, and applies a support threshold. Vigil does the same: count failures-without vs successes-with, apply `minEvidence`. The mechanisms are identical — the domain is different (agent tool calls instead of business process events).

### Systems comparison

| System | What it does | Gap Vigil fills |
|--------|-------------|-------------------------|
| **Declare Miner** [16] | Mines LTLf constraints from event logs | Offline batch analysis; no inline enforcement |
| **Declare Monitor** [17] | Evaluates LTLf over live event streams | Enforces but doesn't discover |
| **ANNEAL** [7] | Recurring failures → symbolic patches | Bespoke system, not an SDK primitive |
| **AGrail** [6] | Adaptive safety with transferable memory | LLM in enforcement path (non-deterministic) |
| **Agent-C** [1] | DSL + SMT temporal constraints | Human-authored only, no discovery |
| **Invariant Labs** [3] | Trace-level policy enforcement | Static rules, no adaptation |

Vigil is the first system to combine Declare-style temporal monitoring with Declare-style constraint mining in a single in-loop primitive for agent execution.

</details>

---

<details>
<summary><strong>Appendix C: Relationship to Cedar and RiskGate</strong></summary>

| Dimension | CedarAuthorization | Vigil | RiskGate |
|-----------|-------------------|-------|----------|
| **Language** | Cedar | Dogwood (Cedar + temporal) | — |
| **Question** | Who can call what? | Is it safe to call now, given history? | How risky? |
| **Statefulness** | Stateless per-request | Stateful over event history | Stateless |
| **Policies** | Authored | Authored + optionally discovered | — |
| **LLM in hot path?** | No | No | No |

CedarAuthorization and Vigil are the same pattern at different levels:
- **CedarAuthorization** evaluates Cedar policies (stateless authz) on `beforeToolCall`
- **Vigil** evaluates Dogwood policies (temporal constraints) on `beforeToolCall`

Cedar is a subset of Dogwood — a Dogwood policy with no `temporal` clause is valid Cedar. The handlers compose naturally: Cedar answers "is this user allowed?", Vigil answers "is it safe given what already happened?"

</details>

---

<details>
<summary><strong>References</strong></summary>

[1] Kamath et al., "Agent-C: Enforcing Temporal Constraints for LLM Agents," arXiv 2512.23738, Dec 2025.

[2] AWS, "Amazon Bedrock Guardrails," aws.amazon.com/bedrock/guardrails/.

[3] Invariant Labs, github.com/invariantlabs-ai/invariant. Acquired by Snyk, June 2025.

[4] LangChain, "LangSmith," langchain.com/langsmith.

[5] Google, "Vertex AI Agent Engine," cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview.

[6] Luo et al., "AGrail: A Lifelong Agent Guardrail with Effective and Adaptive Safety Detection," arXiv 2502.11448, Feb 2025.

[7] Hakim et al., "ANNEAL: Adapting LLM Agents via Governed Symbolic Patch Learning," arXiv 2605.16309, May 2026.

[8] "AIR: Improving Agent Safety through Incident Response," ICML 2026.

[9] "Harness Engineering," arXiv 2607.08028, 2026.

[10] Xiang et al., "GuardAgent: Safeguard LLM Agents by a Guard Agent via Knowledge-Enabled Reasoning," arXiv 2406.09187, 2024.

[11] "POLARIS," arXiv 2605.24883, ACL 2026.

[12] MemOS Group, "From Memory to Skills: Training-Free Procedural Know-How Extraction for Agent Improvement," arXiv 2607.16621, July 2026.

[13] Kambhampati et al., "LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks," ICML 2024, arXiv 2402.01817.

[14] Havelund, Peled, Ulus, "DejaVu: A Monitoring Tool for First-Order Temporal Logic," github.com/havelund/dejavu.

[15] Weil-Kennedy et al., "Runtime Verification of Interactions Using Automata," arXiv 2511.00531, 2025.

[16] Maggi, Mooij, van der Aalst, "User-Guided Discovery of Declarative Process Models," CIDM 2011.

[17] De Giacomo, De Masellis, Maggi, Montali, "Monitoring Constraints and Metaconstraints with Temporal Logics on Finite Traces," arXiv 2004.01859, 2020.

[18] Dogwood Policy Language, github.com/dogwood-policy/dogwood.

</details>
