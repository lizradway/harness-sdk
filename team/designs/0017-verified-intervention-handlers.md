# Trellis: Temporal Constraint Mining from Agent Execution

![A wooden trellis with climbing plants](https://raw.githubusercontent.com/lizradway/harness-sdk/feat/vigil-handler/team/designs/assets/trellis.png)

**Status**: Proposed

**Date**: 2026-07-29

**Issue**: TBD

---

<details>
<summary><strong>Definitions</strong></summary>

| Term | Definition |
|------|-----------|
| **Trellis** | A wooden framework that guides plant growth. |
| **Constraint mining** | Discovering temporal constraints from observed execution patterns — the same technique as Declare mining (process mining, Maggi et al. 2012) applied to agent tool calls instead of business process events. |
| **Intervention Handler** | The Strands SDK's first-class control primitive (design 0007). Intercepts lifecycle events, evaluates against rules, returns Proceed/Deny/Guide/Transform/Confirm. |
| **Dogwood** | Cedar extended with bounded past-time Metric First-Order Temporal Logic (MFOTL). Adds `formerly`, `previous`, `since` operators and aggregations (`count`, `sum`) over event history. The enforcement language for mined constraints. Open source at [github.com/dogwood-policy/dogwood](https://github.com/dogwood-policy/dogwood). |
| **Temporal constraint** | A constraint whose evaluation depends on what already happened in the current execution — prerequisites, loops, cascades, budgets. Requires temporal operators over event history, not just the current request. |

</details>

---

[Problem](#problem) · [Goals and Non-Goals](#goals-and-non-goals) · [Proposal](#proposal) · [Constraint Language](#dogwood-as-constraint-language) · [Developer Experience](#developer-experience) · [Consequences](#consequences)

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

### Why not generate constraints with an LLM?

An LLM can guess that `charge` requires `authenticate` — it's a reasonable inference. The problem isn't generation; it's **validation**. You'll get a mix of real constraints and false ones, and false constraints are worse than missing ones: they silently block valid agent behavior with no visible signal that anything went wrong.

To separate real from false, you need to observe execution. And here's the key insight: **your agents are already hitting these failures.** They hit the 403, they exceed the rate limit, they call deploy without the health check — and then the error vanishes into a log. Trellis doesn't create new failures; it turns the failures you're already eating into constraints that prevent recurrence. The first failure is the cost; every subsequent one is waste.

### Enforcement must be deterministic

Once you know a constraint — whether authored or discovered — you need a gate the model cannot circumvent. Putting constraints in the prompt (or memory, or system instructions) is fundamentally insufficient. This is not a model quality problem — it's architectural:

- **Remembering isn't enforcing.** Memory systems solve knowledge propagation — Agent A learns that `charge` requires `authenticate`, and memory can surface that to Agent B. But a remembered constraint is just a more sophisticated system prompt. It's still advisory: the model can ignore it under pressure, adversarial prompts can override it, and you can't audit or test compliance.

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

This is what Trellis does. Failures become constraints, constraints become enforcement, enforcement transfers across agents. The authored-policy path exists (and is the right choice when you know your constraints), but the novel contribution is closing the loop from observed failure → deterministic prevention automatically.

The technique is process mining applied to agent execution. The Declare Miner (Maggi et al., 2012) counts activations, fulfillments, and violations in event logs to discover temporal constraints over business processes. Trellis does the same — count failures-without vs. successes-with, apply an evidence threshold, promote to enforcement. The algorithm is proven in a different field; the domain is new.

---

## Goals and Non-Goals

### Goals

1. **Constraint mining**: mine temporal constraints from observed failure patterns — no manual rule authoring required. Failures become enforced policies automatically.
2. **Same-session enforcement**: mined constraints begin enforcing within the same session. No redeploy, no restart.
3. **Cross-agent transfer**: persist mined constraints to storage so new agents inherit protection without ever seeing a failure.
4. **Deterministic enforcement**: no LLM in `beforeToolCall`. Compiled constraints evaluate as set lookups and counter checks (microseconds).
5. **Authored policy support**: also works with purely human-written constraints (zero mining) for known risks.
6. **Composition**: standard intervention pipeline — composes with Cedar, RiskGate, steering, HITL.

### Non-Goals

- Replacing Cedar for identity/permission checks.
- Replacing authored Dogwood for infrastructure-level enforcement (Trellis is inside the loop, not at the gateway).
- Offline trace analysis or log processing (the miner operates over the live event stream, not stored traces).
- Real-time LLM-based enforcement (too slow, non-deterministic, bypassable).
- Formal verification of the mining algorithm itself (mining is statistical, not formally verified).

---

## Proposal

### Core concept: mine constraints from execution, enforce them deterministically

Trellis applies process mining to agent execution. It watches the agent's tool-call stream, mines temporal constraints from observed failure patterns, and enforces them deterministically — all inline, no redeploy, no human authoring required.

The mechanism is a Dogwood policy intervention handler (the temporal counterpart to `CedarAuthorization`), but the novel contribution is the mining: failures become constraints automatically.

```typescript
// Mining enabled — zero-config, learns from execution
const trellis = new Trellis({
  discover: true,
  storage: new DynamoDBStorage({ table: 'agent-constraints' }),
})

// Authored policies — Dogwood text (like CedarAuthorization takes Cedar text)
const trellis = new Trellis({
  policies: `
    forbid(principal, action == Action::"charge", resource)
    unless temporal { formerly Action::"authenticate"::request };

    forbid(principal, action == Action::"charge", resource)
    when temporal { count(Action::"charge"::request) >= 5 };
  `,
  discover: true, // also mine new ones
  storage,
})
```

| Mode | What it does | LLM needed? |
|------|-------------|-------------|
| **Mine + enforce** | Observe execution, mine constraints from failures, enforce all | Mining: no. Enforcement: no. |
| **Enforce only** | Evaluate authored constraints against trajectory | No |

The handler advances over the agent's event stream — every `beforeToolCall` evaluates constraints against the trajectory so far, every `afterToolCall` records the outcome and runs the mining algorithm.

```
beforeToolCall → evaluate constraints against trajectory → proceed/deny
afterToolCall  → update trajectory + mine patterns from failures
```

The "trajectory" is a Set of completed tools + a Map of call counts + a Set of failed tools. It lives in memory for the duration of the agent's execution.

### How Trellis works

A single `InterventionHandler` with two responsibilities:

**Enforcement (always):**
1. **Evaluates** constraints against the current trajectory on every `beforeToolCall`
2. **Records** tool outcomes into the trajectory on every `afterToolCall`
3. **Denies** calls that violate constraints deterministically

**Mining (when `discover: true`):**
4. **Mines** constraint patterns from observed failures (statistical process mining)
5. **Validates** mined constraints against evidence thresholds before enforcing
6. **Persists** mined constraints to storage for cross-agent transfer
7. **Self-corrects** — demotes constraints that humans consistently override

### What it mines

| Pattern | Signal | Dogwood policy | Compiled form |
|---------|--------|----------------|---------------|
| **Authorization** | Tool always fails for this principal/resource | `forbid(principal, action == Action::"X", resource)` | `{ type: 'forbid', tool, principal?, resource? }` |
| **Prerequisites** | Tool B fails without A; succeeds with A | `forbid ... unless temporal { formerly Action::"A"::request }` | `{ type: 'requires', tool, condition }` |
| **Loops** | Same tool + same args repeated | `forbid ... when temporal { count(same input) >= N }` | `{ type: 'loop', tool, maxRepeats }` |
| **Cascades** | When A fails, B always fails after | `forbid ... when temporal { formerly A::resolution{error} }` | `{ type: 'cascade', trigger, blocks }` |
| **Budgets** | Tool exceeds max calls | `forbid ... when temporal { count(...) >= N }` | `{ type: 'budget', tool, maxCalls }` |

Dogwood is a superset of Cedar — stateless authorization is just the degenerate case where no temporal operators are needed. Trellis mines both: a tool that always fails regardless of context is an authz constraint; a tool that fails only without a prerequisite is temporal. The temporal observation stream is what enables mining *all* constraint types — it provides the data to distinguish "always fails" (stateless) from "fails without X" (temporal). Every mined constraint is compiled to a typed JSON form that evaluates as a set membership check or counter comparison — microseconds, no ambiguity.

**Future mining targets** (not yet implemented):

| Pattern | Signal | Dogwood policy | Temporal? |
|---------|--------|----------------|-----------|
| **Input-value** | Tool fails when `amount > N` | `forbid ... when context.input.amount > N` | No — Cedar `when` clause |
| **Resource-specific** | Tool fails on resource Y but succeeds on others | `forbid(principal, action, Resource::"Y")` | No — Cedar resource scope |
| **Temporal + value** | Tool fails after N calls *with same input* | `forbid ... when temporal { count(same input) >= N }` | Yes — already `loop` type |
| **Sequence** | Tool C fails unless A then B in order | `forbid ... unless temporal { formerly B after formerly A }` | Yes — ordered `formerly` |

The temporal awareness is the *mechanism* that enables mining — it sees ordering, counts, and causal relationships — but the constraints it produces span the full Dogwood/Cedar expressiveness, from stateless authz to multi-step temporal ordering.

### The mining algorithm

Pattern detection runs after every `afterToolCall` as part of event processing. No LLM call. This is Declare mining (Maggi et al., 2012) applied to agent tool calls — count activations vs. violations, apply an evidence threshold, promote to enforcement.

#### Prerequisite mining

For each tool `B` that just succeeded, check if there's a tool `A` that distinguishes successes from failures:

```
confidence(B requires A) = failuresWithout(A) / totalFailures(B)
support = failuresWithout(A) ≥ minEvidence AND successesWith(A) ≥ 1
```

If `support` is met: promote `{ type: 'requires', tool: B, condition: A }` to enforcing.

**Worked example:**

```
observations = []

Call 1: charge() → fail    → observations: [{tool: charge, success: false, preceding: []}]
Call 2: charge() → fail    → observations: [{...}, {tool: charge, success: false, preceding: []}]
Call 3: charge() → fail    → observations: [{...}, {...}, {tool: charge, success: false, preceding: []}]
Call 4: authenticate() → ok → observations: [{...}, {...}, {...}, {tool: authenticate, success: true, ...}]
Call 5: charge() → ok      → observations: [{...}, {...}, {...}, {...}, {tool: charge, success: true, preceding: [authenticate]}]

Mining triggers on Call 5 (charge succeeded):
  failuresWithout(authenticate) = 3  (calls 1-3 had no authenticate in preceding)
  successesWith(authenticate)   = 1  (call 5 had authenticate in preceding)
  3 ≥ minEvidence(3) AND 1 ≥ 1      → PROMOTE

Call 6: charge() → beforeToolCall → evaluate requires constraint
  completedTools.has('authenticate') → false → DENY
```

#### Budget mining

For each tool, track the transition point where successes stop and failures start:

```
maxSuccessfulCalls = max index where tool succeeded consecutively
failuresAfterMax   = failures at call indices > maxSuccessfulCalls
support            = failuresAfterMax ≥ minEvidence AND maxSuccessfulCalls > 0
```

If `support` is met: promote `{ type: 'budget', tool, maxCalls: maxSuccessfulCalls }`.

#### Implementation

```typescript
private _detectPrerequisiteFromSuccess(successTool: string): void {
  const failures = this._observations.filter(o => o.tool === successTool && !o.success)
  const successes = this._observations.filter(o => o.tool === successTool && o.success)

  if (failures.length < this._minEvidence || successes.length === 0) return

  for (const prereq of this._candidatePrereqs(successes)) {
    const failuresWithout = failures.filter(o => !o.precedingTools.includes(prereq)).length
    const successesWith = successes.filter(o => o.precedingTools.includes(prereq)).length

    if (failuresWithout >= this._minEvidence && successesWith >= 1) {
      this._promoteConstraint({ type: 'requires', tool: successTool, condition: prereq })
    }
  }
}
```

**LLM-assisted mining** analyzes failure patterns and proposes constraints that statistical detection misses — error message interpretation, domain-specific rules, multi-step reasoning about why a sequence failed. Every proposal passes through the same validation pipeline: the LLM proposes, execution validates. This is not a future enhancement; it's a core mining mode alongside statistical detection.

### Validation before enforcement

A mined constraint must pass:

1. **Minimum evidence** — enough observations to be statistically meaningful (configurable, default 3)
2. **Causal confirmation** — at least one success where the proposed condition was met
3. **Consistency check** — no circular dependencies ("A requires B" + "B requires A")
4. **Canary period** — optional shadow mode (default: 0, immediate enforcement)

### Self-correction and demotion

If humans override a denial more than a threshold percentage, the constraint demotes:

| Tier | Action | Semantics |
|------|--------|-----------|
| **Enforced** | `deny()` | Invariant — always true |
| **Advisory** | `confirm()` or `guide()` | Usually true but exceptions exist — escalate to human or steer the model |
| **Retired** | no-op | Pattern isn't reliable |

"Authenticate before charge" is invariant. "Run tests before deploy" is contextual (valid to skip for a hotfix). The first stays enforced; the second demotes to advisory and raises HITL confirmation.

---

## Constraint Language (Dogwood)

Every constraint — whether authored or mined from execution — is represented as a Dogwood temporal policy. Dogwood extends Cedar with temporal operators (`formerly`, `count`, `since`) so it can express "is it safe to call *given what already happened*?" — not just "is this principal allowed?"

The typed JSON IS compiled Dogwood — `requires` is compiled `formerly`, `budget` is compiled `count`. The miner produces the compiled form directly, and the evaluator consumes it as TypeScript set lookups and counter checks. **No Dogwood parser, CLI, or WASM module is in the runtime path.** The evaluation is pure TypeScript:

```typescript
// This IS the "Dogwood runtime" — set membership, not a policy engine
if (constraint.type === 'requires' && !completedTools.has(condition)) {
  return deny(...)
}
if (constraint.type === 'budget' && callCount >= constraint.maxCalls) {
  return deny(...)
}
```

Dogwood text is the canonical representation for auditing and sharing — a human-readable form of what's enforced. The `policies` config field will accept Dogwood text when a parser ships (WASM module), but the enforcement path never needs one. The typed JSON is self-sufficient.

| Layer | What exists today | Future |
|-------|-------------------|--------|
| **Authoring** | `compiledConstraints` (typed JSON) | `policies` (Dogwood text → parsed by WASM) |
| **Mining output** | Typed JSON directly | Same — miner always produces compiled form |
| **Evaluation** | TypeScript set/counter checks | Same — already microseconds |

---

## Developer Experience

### Mining mode (zero-config)

```typescript
import { Agent } from '@strands-agents/sdk'
import { Trellis } from '@strands-agents/sdk/vended-interventions/trellis'

const trellis = new Trellis({
  discover: true,
  storage: new DynamoDBStorage({ table: 'agent-constraints' }),
})

const agent = new Agent({
  tools: [authenticate, charge, refund],
  interventions: [trellis],
})

// The handler watches, mines, and enforces — all inline:
// charge() fails without auth → evidence accumulates → constraint mined → subsequent charge() DENIED
// Mined constraints persist to storage → next agent loads them on startup
```

### Authored policies (Dogwood text)

```typescript
// Dogwood text — the authoring surface (like Cedar for CedarAuthorization)
const trellis = new Trellis({
  policies: `
    forbid(principal, action == Action::"promote", resource)
    unless temporal { formerly Action::"health_check"::request };

    forbid(principal, action == Action::"charge", resource)
    when temporal { count(Action::"charge"::request) >= 5 };
  `,
  discover: true,  // also mine new constraints from execution
  storage,
})
```

Authored policies enforce immediately. Mining finds additional constraints from execution. Both coexist.

### Compiled constraints (escape hatch)

When the Dogwood WASM parser isn't available, or for programmatic construction:

```typescript
// Compiled form — what the miner produces internally
const trellis = new Trellis({
  compiledConstraints: [
    { type: 'requires', tool: 'promote', condition: 'health_check' },
    { type: 'budget', tool: 'charge', maxCalls: 5 },
  ],
  discover: true,
  storage,
})
```

The compiled JSON form is the internal representation — it's what the miner produces and the evaluator consumes. The `policies` field is the intended authoring surface; `compiledConstraints` is for programmatic use or when a parser isn't yet available.

### Composition

```typescript
const agent = new Agent({
  tools: [...],
  interventions: [
    cedarAuth,      // WHO can call (identity)
    riskGate,       // WHAT risk level (classification + HITL)
    trellis,          // WHEN is it safe (temporal constraints)
  ],
})
```

Each answers a distinct question. The pipeline short-circuits — if Cedar denies, nothing else fires.

### Inspection

```typescript
trellis.getEnforcingConstraints()
// [{ constraint: { type: 'requires', tool: 'charge', condition: 'authenticate' },
//    status: 'enforcing', evidence: { failures: 4, successes: 2, overrides: 0 },
//    source: 'discovered' }]
```

---

## Consequences

### What becomes easier

- **Constraints emerge from execution.** No human writes rules. Failures become enforced policies automatically.
- **Institutional memory.** Mined constraints persist. One agent's failures protect all future agents.
- **Microsecond enforcement.** Compiled constraints evaluate as set lookups. No LLM, no latency, no token cost.
- **Immune to prompt injection.** Enforcement is code. Adversarial messages cannot override.
- **Auditable.** Every denial has a reason, a constraint with provenance (authored vs. mined), and evidence.
- **Self-correcting.** Constraints that humans override demote rather than accumulate.
- **Temporal enforcement as an SDK primitive.** `interventions: [trellis]` — same pattern as Cedar for authz.

### What requires care

- **Mining needs failures.** Cannot prevent the *first* occurrence. For known risks, author constraints directly.
- **Frontier models self-correct from clear errors.** If the error message contains the fix ("Authentication required"), the model corrects within the same turn and the failure never accumulates. Mining is most valuable for opaque errors, rate limits, and cross-invocation scenarios.
- **Mined constraints may be wrong.** Validation mitigates but doesn't eliminate false positives. Review mined constraints for safety-critical tools.
- **Cold start.** A fresh handler with no constraints and no storage enforces nothing. Author constraints or pre-seed storage.
- **Storage for cross-agent transfer.** In-memory mode works for single-agent use but doesn't survive restarts.

---

## Empirical Results

### Synthetic scenarios (unit tests)

Simulated agent calling `charge` without `authenticate` (prerequisite violation), 30 invocations:

| Phase | Failures | Blocked | Failure Rate |
|-------|----------|---------|--------------|
| Learning (rounds 1–4) | 4 | 0 | 80% |
| Enforcing (rounds 5–30) | 0 | 20 | 0% |

**Post-mining failure rate: 0%.** Convergence: 3 failures + 1 causal confirmation.

Cross-agent transfer eliminates cold start: the second agent loading from storage has zero failures from its first call.

### Real-model benchmark (Claude Sonnet 4.6 via Bedrock)

Fresh agent per invocation (no conversation history carryover), same Trellis instance accumulating observations across invocations.

**Opaque prerequisite** (`submit_result` requires `activate_session`, error message: "submission rejected"):

| Round | Outcome |
|-------|---------|
| 1–3 | `submit_result` fails (session not active). Model cannot self-correct — error is opaque. |
| 4 | User prompt includes activation. Success provides causal confirmation. **Constraint mined.** |
| 5 | Trellis **blocks** `submit_result` without `activate_session`. Model structurally prevented. |

Evidence at discovery: `failures=3, successes=1`. Constraint: `{ type: 'requires', tool: 'submit_result', condition: 'activate_session' }`.

**Budget** (`process_item` rate-limited after 3 calls):

| Round | API Calls | Over Limit |
|-------|-----------|-----------|
| 1 | 5 | 2 |
| 2–4 | 4 | 1 |

Budget constraints mined and enforcing after round 1 (3 successes + 2 failures in one batch provides immediate evidence).

### When mining matters (and when it doesn't)

Frontier models with clear error messages **self-correct within the same invocation**. Claude reads "403: Authentication required" and authenticates on its next turn — the failure never accumulates across invocations. Mining adds no value here.

Mining's value is for **irrecoverable failures** — where the cost IS the failure itself:

| Scenario | Why model can't self-correct | Mining value |
|----------|------------------------------|--------------|
| **Rate limits / budgets** | The 4th call locks the account. No retry fixes it. | Prevents the call entirely |
| **Opaque errors** | "Error: request failed" — no remediation hint | Model can't deduce what's missing |
| **Loops** | Each repeated call "works" — no error signal | Model doesn't realize it's looping |
| **Cross-invocation** | Fresh agent, no history from prior failure | Same mistake repeated indefinitely |
| **Weaker models** | Don't interpret error messages well | Can't self-correct even from clear errors |

Mining doesn't find things models can't figure out. It **prevents failures whose cost is the failure itself.** Prevention vs. recovery.

---

<details>
<summary><strong>Appendix A: Mining Algorithm</strong></summary>

### Observation

On every `afterToolCall`: tool name, args hash, success/failure, error, preceding tools in this invocation. This is the monitor advancing its state.

### Pattern mining (inline)

After each observation, the miner checks for discoverable patterns:

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

Trellis's lineage is most directly Declare monitoring (temporal monitor over event stream) + Declare mining (discover constraints from observed patterns) + ANNEAL (structural repair — discovered constraints prevent recurrence).

### The Declare Miner parallel

The Declare Miner counts **activations** (tool called) and **fulfillments** (prerequisite met) vs **violations** (prerequisite absent), computes confidence, and applies a support threshold. Trellis does the same: count failures-without vs successes-with, apply `minEvidence`. The mechanisms are identical — the domain is different (agent tool calls instead of business process events).

### Systems comparison

| System | What it does | Gap Trellis fills |
|--------|-------------|-------------------------|
| **Declare Miner** [16] | Mines LTLf constraints from event logs | Offline batch analysis; no inline enforcement |
| **Declare Monitor** [17] | Evaluates LTLf over live event streams | Enforces but doesn't discover |
| **ANNEAL** [7] | Recurring failures → symbolic patches | Bespoke system, not an SDK primitive |
| **AGrail** [6] | Adaptive safety with transferable memory | LLM in enforcement path (non-deterministic) |
| **Agent-C** [1] | DSL + SMT temporal constraints | Human-authored only, no discovery |
| **Invariant Labs** [3] | Trace-level policy enforcement | Static rules, no adaptation |

Trellis is the first system to combine Declare-style temporal monitoring with Declare-style constraint mining in a single in-loop primitive for agent execution.

</details>

---

<details>
<summary><strong>Appendix C: Relationship to Cedar and RiskGate</strong></summary>

| Dimension | CedarAuthorization | Trellis | RiskGate |
|-----------|-------------------|-------|----------|
| **Language** | Cedar | Dogwood (Cedar + temporal) | — |
| **Question** | Who can call what? | Is it safe to call now, given history? | How risky? |
| **Statefulness** | Stateless per-request | Stateful over event history | Stateless |
| **Policies** | Authored | Authored + optionally discovered | — |
| **LLM in hot path?** | No | No | No |

CedarAuthorization and Trellis are the same pattern at different levels:
- **CedarAuthorization** evaluates Cedar policies (stateless authz) on `beforeToolCall`
- **Trellis** evaluates Dogwood policies (temporal constraints) on `beforeToolCall`

Cedar is a subset of Dogwood — a Dogwood policy with no `temporal` clause is valid Cedar. The handlers compose naturally: Cedar answers "is this user allowed?", Trellis answers "is it safe given what already happened?"

### Dogwood operators

| Operator | Semantics | Maps to |
|----------|-----------|---------|
| `formerly within W` | Some matching event occurred within window W | Prerequisites |
| `count(...)` | Aggregate count of matching events | Budgets |
| `previous` | The immediately preceding event | Loop detection |
| `since` | Property held continuously since condition | Cascades |

### Dogwood event model

| Dogwood concept | Agent hook | Role |
|-----------------|-----------|------|
| `request` | `beforeToolCall` | Decision point — triggers authorization |
| `resolution` | `afterToolCall` | History-only — records outcome for temporal queries |

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
