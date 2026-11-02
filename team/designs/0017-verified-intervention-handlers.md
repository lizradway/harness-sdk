# Trellis: Learning Constraints from Agent Execution

![A wooden trellis with climbing plants](https://raw.githubusercontent.com/lizradway/harness-sdk/feat/vigil-handler/team/designs/assets/trellis.png)

**Status**: Proposed

**Date**: 2026-07-29

**Issue**: TBD

---

<details>
<summary><strong>Definitions</strong></summary>

| Term | Definition |
|------|-----------|
| **Trellis** | A wooden frame that stops plant growth in unsupported directions and guides it along supported ones. |
| **Constraint mining** | Discovering behavioral constraints from observed execution patterns. The same technique as Declare mining (process mining, Maggi et al. 2012) applied to agent tool calls instead of business process events. |
| **Intervention Handler** | The Strands SDK's first-class control primitive (design 0007). Intercepts lifecycle events, evaluates against rules, returns Proceed/Deny/Guide/Transform/Confirm. |
| **Dogwood** | Cedar extended with bounded past-time Metric First-Order Temporal Logic (MFOTL). Adds `formerly`, `previous`, `since` operators and aggregations (`count`, `sum`) over event history. One of several export targets for mined constraints. Open source at [github.com/dogwood-policy/dogwood](https://github.com/dogwood-policy/dogwood). |
| **Behavioral constraint** | A constraint on agent tool-call behavior. Some are temporal (prerequisites, cascades, sequences: depend on execution history), some are stateless (forbid, budget: depend on current state or counts only). All are mined from the same observation stream. |

</details>

---

[Problem](#problem) · [What](#what-trellis-is) · [How](#how-it-works) · [Developer Experience](#developer-experience) · [Consequences](#consequences)

---

## Problem

Production agents need policy enforcement. Cedar, Dogwood, OPA — pick your language, the point is the same: deterministic gates that the model cannot circumvent. This isn't optional anymore. An agent without policy enforcement is a liability.

But nobody is writing these policies by hand. They're LLM-generating them — "here's my agent, write me Cedar policies." And that works for the constraints you already know about. But agents fail in ways you can't predict — the problem is the constraints you don't know about yet.

### Your policy is always incomplete

Every static approach — system prompts, Cedar policies, guardrail configs — assumes you already know the constraints. But agents talk to systems they don't fully control, and most constraints are implicit:

- The payment API returns 403 without `authenticate` first. No documentation says so.
- The rate limit locks the account on the fourth call. The tool description doesn't mention it.
- The third-party API silently corrupts data if you call `update` before `refresh`. You learn this from a production incident.

Constraints are latent in the environment [14]. You can't enumerate them upfront because you don't know what they are until you hit them. An LLM can guess some of them — but guessed constraints are worse than missing ones if they're wrong, because they silently block valid behavior with no signal that anything went wrong.

To validate, you need to observe execution. And here's the key insight: **your agents are already hitting these failures.** They hit the 403, they exceed the rate limit, they call deploy without the health check, and then the error vanishes into a log. Trellis doesn't create new failures; it turns the failures you're already eating into constraints that prevent recurrence. The first failure is the cost; every subsequent one is waste.

### Enforcement must be deterministic

Once you know a constraint — whether authored, generated, or discovered — you need a gate the model cannot circumvent. Putting constraints in the prompt is fundamentally insufficient:

- **Safety competes with the task.** The model weighs "don't call charge without auth" against "process this payment urgently." Under pressure, the task wins. Agent-C [1]: 100% conformance with deterministic enforcement vs 77.4% with the model self-policing.
- **Prompts don't scale.** Three constraints fit in a system prompt. Fifty don't. Each competes for attention with the actual task. Every constraint you add dilutes the attention available for every other constraint.
- **You can't audit or test a prompt.** "Prove no deployment skipped a health check this month." With a prompt, you can't. With a deterministic gate: `expect(tool).toHaveBeenBlocked()`.
- **Constraints are model-portable.** Switch from Claude to GPT to Llama, and every prompt-based rule needs re-testing. A deterministic gate evaluates the same regardless.

### The problem, stated simply

**You LLM-generate policies for the constraints you know. How do you validate them, refine them, and fill the gaps you didn't know existed — without requiring a human to discover each missing rule?**

1. **Validate**: does "authenticate before charge" actually hold in this environment? Execution confirms or disproves it.
2. **Refine**: "max 3 API calls" is imprecise. Which tool? Per session? Per user? Execution sharpens it.
3. **Discover**: what did you miss entirely? Execution reveals constraints you didn't know existed.

Trellis is the next step after LLM-generated policies. You seed it with your intent (authored or generated); execution validates, refines, and expands it into a complete, enforced policy. The LLM generates hypotheses; the evidence pipeline validates them. No constraint enforces without proof.

---

## What Trellis Is

The lowest-friction path from "I roughly know what my agent shouldn't do" to "it's deterministically enforced, tested, and transferred across all my agents."

You seed it with what you know. Execution validates, refines, and expands your policy into a complete set of deterministically enforced constraints.

|  | **Hard (code gate)** | **Soft (guidance)** |
|--|---------------------|---------------------|
| **Authored** | Policy languages (Cedar, Dogwood, OPA) | Steering, Skills |
| **Learned** | Mined constraints (Trellis) | Mined skills, procedural memory |

Trellis occupies the **learned × hard** cell. It does not mine skills (learned × soft) or replace steering (authored × soft). Those are separate primitives that compose alongside it in the interventions array.

```
beforeToolCall → evaluate constraints against trajectory → proceed/deny
afterToolCall  → update trajectory + mine patterns from failures
```

### Goals

1. **Prevent, not recover.** Block violations before they happen, not after.
2. **Transfer across agents.** One agent's failure protects every future agent. Fresh agents inherit protection without ever seeing the failure.
3. **Mine constraints from failures**, no manual rule authoring required.
4. **Deterministic.** No LLM in the enforcement path (microseconds). Immune to prompt injection.
5. **Policy-language agnostic.** Typed JSON natively, or delegate to Cedar/Dogwood/OPA.

### Non-Goals

- Replacing Cedar for identity/permission checks
- Mining skills or procedures: Trellis mines what *not* to do (failures → hard gate), not what *to* do (successes → guidance). That's a skills/memory layer.
- Steering: same intent expressed as a prompt-based suggestion the model can ignore under pressure (Agent-C: 22.6% failure rate).

### What it mines

| Pattern | Signal | Typed JSON form |
|---------|--------|-----------------|
| **Prerequisites** | Tool B fails without A; succeeds with A | `{ type: 'requires', tool, condition }` |
| **Loops** | Same tool + same args repeated | `{ type: 'loop', tool, maxRepeats }` |
| **Cascades** | When A fails, B always fails after | `{ type: 'cascade', trigger, blocks }` |
| **Budgets** | Tool exceeds max calls | `{ type: 'budget', tool, maxCalls }` |


### Constraint representation

Trellis is **policy-language agnostic**. It mines typed constraint objects and evaluates them with native TypeScript set/counter checks. No dependency on any policy language runtime.

```typescript
if (constraint.type === 'requires' && !completedTools.has(condition)) {
  return deny(...)
}
if (constraint.type === 'budget' && callCount >= constraint.maxCalls) {
  return deny(...)
}
```

To delegate enforcement to an external policy engine instead, pass a handler:

```typescript
const trellis = new Trellis({
  policy: new CedarAuthorization(),
})
```

Mined constraints can also be exported for governance, auditing, or infrastructure-level enforcement:

| Target | Export form | Use case |
|--------|-----------|----------|
| **Dogwood** | `forbid ... unless temporal { formerly ... }` | Temporal enforcement at infrastructure layer |
| **Cedar** | `forbid(principal, action, resource) when { ... }` | Stateless authz integration |
| **OPA/Rego** | `deny[msg] { not input.preceding[_] == "authenticate" }` | Policy-as-code pipelines |
| **Custom** | Typed JSON as-is | Programmatic consumption |

---

## How It Works

### The mining algorithm

Pattern detection runs after every `afterToolCall`. No LLM call. This is Declare mining (Maggi et al., 2012) applied to agent tool calls.

For each candidate constraint, the miner tracks:
1. **Activations**: how many times the situation arose (e.g. `charge` was called)
2. **Violations**: how many of those times the constraint was broken (e.g. `authenticate` hadn't run)
3. **Confirmations**: at least one case where the constraint held and the tool succeeded

When violations ≥ evidence threshold and confirmations ≥ 1, the constraint promotes from candidate to enforcing.

```
confidence(B requires A) = failuresWithout(A) / totalFailures(B)
support = failuresWithout(A) ≥ minEvidence AND successesWith(A) ≥ 1
```

A mined constraint must pass: (1) minimum evidence threshold, (2) causal confirmation (at least one success where the condition was met), (3) consistency check (no circular deps). See Appendix A for worked examples, budget mining, and implementation details.

When `extraction` is configured, Trellis uses an LLM to propose constraints that statistical detection misses. Every proposal passes through the same validation pipeline: the LLM accelerates discovery, execution validates. No constraint enforces without evidence.

### Constraint visibility

Enforcing constraints are surfaced to the agent so it can plan around them rather than discovering them through failed tool calls.

```typescript
beforeToolCall → evaluate constraints against trajectory → proceed/deny
                                                          ↑
system prompt injection: "deploy requires health_check"   │
agent plans accordingly ─────────────────────────────────→│ denial is a bug, not normal flow
```

The agent sees "deploy requires health_check" and routes around it. If it still tries, the gate still blocks — knowing the rule doesn't let you bypass it. The adversarial robustness property is preserved: visibility is not override-ability.

Why this matters: a `deny()` that fires is expensive — a wasted tool call, a recovery turn, context spent on the error. Surfacing constraints upfront turns denial from the expected learning mechanism into an anomaly signal.

The surfacing has to be unconditional, not gated on whether the constraint currently applies. An agent often creates the violation inside a single turn (a batch of parallel calls where the first invalidates the precondition of the rest), and a check of the trajectory *between* turns is correctly satisfied right before that batch. Announcing the rule every turn is what changes the agent's plan; evaluating it against the current state only tells you it does not yet apply. Measured on the config-repair benchmark below: announced rules eliminated wasted calls (0.0 per trial with the gate, 0.3 without), while state-gated hints matched plain denial (3.3 vs 3.0).

### Self-correction

Mined constraints can be wrong. Trellis handles this through **override tracking and automatic demotion**:

| Tier | Action | Demotion trigger |
|------|--------|-----------------|
| **Enforced** | `deny()` | — |
| **Advisory** | `confirm()` | override rate > threshold |
| **Retired** | no-op | override rate > retirement threshold |

"Authenticate before charge" is invariant: it never gets overridden, never demotes. "Run tests before deploy" is contextual: valid to skip for a hotfix, so it accumulates overrides and demotes to advisory. See Appendix A for the full demotion cascade.


---

## Developer Experience

### Seed: start with what you know

The `policy` field is your initial intent. Everything you pass enforces immediately. Execution then validates your seeds (are they correct?), refines them (are they precise?), and discovers what you missed.

Start blank (learn everything from scratch):

```typescript
import { Trellis } from '@strands-agents/sdk/vended-interventions/trellis'

const trellis = new Trellis()
```

Seed with known constraints:

```typescript
const trellis = new Trellis({
  policy: [
    { type: 'requires', tool: 'promote', condition: 'health_check' },
    { type: 'budget', tool: 'charge', maxCalls: 5 },
  ],
})
```

Seed with natural language (compiled by agent's model at first tool call):

```typescript
const trellis = new Trellis({
  policy: 'Read-only access to prod. Authenticate before any payment call. No more than 3 API calls per session.',
})
```

Seed with a policy engine handler:

```typescript
const trellis = new Trellis({
  policy: new CedarAuthorization({ policies }),
})
```

### Learn: execution refines and expands your policy

Every `afterToolCall` records the outcome and checks for patterns. Seeds get validated against reality. Gaps get filled. When evidence accumulates, new constraints promote to enforcement automatically.

```typescript
const agent = new Agent({
  tools: [authenticate, charge, refund],
  interventions: [trellis],
})

// charge() fails without auth → evidence accumulates → constraint mined → subsequent charge() DENIED
```

Mined constraints persist in the agent's app state via the session manager.

For faster discovery, enable LLM-assisted extraction:

```typescript
const trellis = new Trellis({
  extraction: true,  // uses the agent's model, moderate sensitivity
})

// Configure sensitivity and thresholds (subset shown — full config TBD)
const trellis = new Trellis({
  extraction: {
    model: new BedrockModel({ modelId: 'us.anthropic.claude-sonnet-5-v1' }),
    sensitivity: 'aggressive',  // propose constraints from fewer signals
    minEvidence: 2,             // require less evidence before enforcing
  },
})

// Or bring your own extractor
const trellis = new Trellis({
  extraction: myCustomExtractor,
})
```

LLM extraction runs on top of deterministic pattern detection. The model proposes candidates; execution validates them through the same evidence pipeline.

Learned constraints persist via the session manager. For infrastructure-level enforcement, write them to external storage and load into a gateway-level policy engine.

### Production deployment

Trellis runs in production. That's where the constraints are — real rate limits, real third-party behavior, real failure modes that staging mocks can't reproduce. In dev, your seeds get validated. In production, the gaps get filled.

Production enforces all known constraints (authored seeds + anything mined in prior environments).

Live mining has three modes:

- **Off** — enforce only, no new discovery. For regulated environments where policy changes require review.
- **Shadow** (default) — mine candidates and log them, but don't enforce. Human reviews and promotes.
- **Live** — mine and enforce automatically when evidence threshold is met. Use higher `minEvidence` and the demotion cascade as safety nets.

### Delegated enforcement

To delegate enforcement to an external policy engine instead of native evaluation:

```typescript
const trellis = new Trellis({
  policy: new CedarAuthorization({ policies }),
})

const trellis = new Trellis({
  policy: new DogwoodHandler(),
})
```

The delegated handler is Trellis's private child. Don't add it to the `interventions` array separately. Trellis manages its lifecycle. If you also pass a CedarAuthorization to the agent's `interventions` array for hard identity/authz checks, Trellis cannot modify it. Those are two isolated instances with separate policy stores: one for your authored authorization rules, one for Trellis's mined behavioral constraints.


---

## Consequences

### What becomes easier

- **Guarantees at scale.** A model that follows instructions 98% of the time still violates across thousands of invocations. A deterministic gate never does.
- **Cross-invocation transfer.** One agent's failure protects every future agent. Fresh agents with no history never repeat a known mistake.
- **Immune to prompt injection.** Enforcement is code. Adversarial messages cannot override a `deny()`.
- **Auditable.** Every denial carries a reason, provenance (authored vs. mined), and evidence counts. `expect(tool).toHaveBeenBlocked()` works in tests.
- **Self-correcting.** Constraints that humans override demote rather than accumulate indefinitely.

### When mining matters

A frontier model can self-correct within a single session: it reads "403: Authentication required" and authenticates on its next turn. But self-correction isn't good enough when:

| Scenario | Why self-correction is insufficient | Mining value |
|----------|-------------------------------------|--------------|
| **Irrecoverable actions** | The 4th call locks the account. Correcting after is meaningless. | Prevents the call entirely |
| **Scale** | 98% compliance × 10,000 invocations = 200 violations | Hard gate: 0 violations |
| **Cross-invocation** | Fresh agent, no history from prior failure | Transfer: same mistake never repeated |
| **Adversarial** | Prompt injection overrides model reasoning (Agent-C: 22.6% failure rate on explicitly stated constraints) | Code gate: immune to prompts |
| **Opaque errors** | "Error: request failed", no remediation hint | Model can't deduce what's missing |
| **Loops** | Each repeated call "works", no error signal | Model doesn't realize it's looping |

Self-correction solves for one session. Trellis solves for all sessions, all agents, at any scale, against any attack. The model discovers the constraint on the first failure; Trellis ensures no subsequent invocation pays that cost again.

Hard enforcement is for when the cost of a single violation exceeds the cost of occasionally blocking a valid action. The demotion cascade handles the gray area: constraints that get overridden frequently weren't worth a hard gate.

### What requires care

- **Mining needs failures.** Cannot prevent the *first* occurrence. For known risks, author constraints directly.
- **Mined constraints may be wrong.** The evidence threshold (minEvidence + causal confirmation) mitigates false positives. Review mined constraints for safety-critical tools.
- **Cold start.** A fresh handler with no constraints enforces nothing until failures accumulate. For known risks, author constraints directly or provide a string policy.

---

---

<details>
<summary><strong>Appendix A: Mining Algorithm and Self-Correction</strong></summary>

### Observation

On every `afterToolCall`: tool name, args hash, success/failure, error, preceding tools in this invocation. This is the monitor advancing its state.

### Pattern mining (inline)

After each observation, the miner checks for discoverable patterns:

- **Prerequisites**: tool B fails without tool A; succeeds with tool A → `requires` constraint
- **Loops**: same tool + same args repeated beyond threshold → `loop` constraint  
- **Cascades**: when tool A fails, tool B always fails after → `cascade` constraint

Pure pattern matching over the observation buffer. Constraints that meet the evidence threshold begin enforcing immediately.

### Prerequisite mining: worked example

```
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

### Budget mining

For each tool, track the transition point where successes stop and failures start:

```
maxSuccessfulCalls = max index where tool succeeded consecutively
failuresAfterMax   = failures at call indices > maxSuccessfulCalls
support            = failuresAfterMax ≥ minEvidence AND maxSuccessfulCalls > 0
```

If `support` is met: promote `{ type: 'budget', tool, maxCalls: maxSuccessfulCalls }`.

### Implementation

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

### Validation

Before a constraint enforces:

1. **Evidence threshold**: at least N failures (default 3)
2. **Causal confirmation**: at least one success where the condition was met
3. **Consistency**: no circular dependencies
4. **Canary** (optional): shadow-mode for M invocations before blocking

### Enforcement

```typescript
// Set membership (microseconds)
if (constraint.type === 'requires' && !completedTools.has(condition)) {
  return deny(`requires: ${condition}`)
}

// Counter check (microseconds)
if (constraint.type === 'loop' && repeats >= maxRepeats) {
  return deny(`loop: ${tool} called ${repeats} times`)
}
```

### Self-correction: full demotion cascade

When a constraint demotes to advisory tier, it returns `confirm()` instead of `deny()`. The human approves or rejects. A rejection is an override, recorded in the constraint's evidence: `{ failures: 4, successes: 2, overrides: 3 }`.

1. Constraint enforces → human overrides → override counter increments
2. Override rate crosses advisory threshold → constraint demotes to `confirm()`
3. Override rate crosses retirement threshold → constraint retires (no-op)
4. Retired constraints stay in app state with provenance so they don't re-discover from the same pattern

A constraint can also be **manually retired** if you know it's wrong without waiting for overrides to accumulate.

### When the environment changes

If a rate limit moves from 3 → 10, the existing `{ type: 'budget', maxCalls: 3 }` constraint starts blocking calls that would now succeed. Two paths to resolution:

- **Override-driven**: calls 4–10 get overridden → constraint demotes → eventually retires → a new budget constraint mines at the correct threshold
- **Explicit update**: admin removes or updates the constraint directly

### Future: advisory-first promotion

A stronger mitigation for false positives: mined constraints start in advisory (`confirm()`) and promote to enforced only after repeated non-overrides. This eliminates silent false blocking entirely but requires HITL infrastructure wired up.

</details>

---

<details>
<summary><strong>Appendix B: Empirical Results</strong></summary>

### Synthetic scenarios (unit tests)

Simulated agent calling `charge` without `authenticate` (prerequisite violation), 30 invocations:

| Phase | Failures | Blocked | Failure Rate |
|-------|----------|---------|--------------|
| Learning (rounds 1–4) | 4 | 0 | 80% |
| Enforcing (rounds 5–30) | 0 | 20 | 0% |

**Post-mining failure rate: 0%.** Convergence: 3 failures + 1 causal confirmation.

Cross-agent transfer eliminates cold start: the second agent sharing app state has zero failures from its first call.

### Real-model benchmark (Claude Sonnet 4.6 via Bedrock)

Fresh agent per invocation (no conversation history carryover), same Trellis instance accumulating observations across invocations.

**Opaque prerequisite** (`submit_result` requires `activate_session`, error message: "submission rejected"):

| Round | Outcome |
|-------|---------|
| 1–3 | `submit_result` fails (session not active). Model cannot self-correct because the error is opaque. |
| 4 | User prompt includes activation. Success provides causal confirmation. **Constraint mined.** |
| 5 | Trellis **blocks** `submit_result` without `activate_session`. Model structurally prevented. |

Evidence at discovery: `failures=3, successes=1`. Constraint: `{ type: 'requires', tool: 'submit_result', condition: 'activate_session' }`.

**Budget** (`process_item` rate-limited after 3 calls):

| Round | API Calls | Over Limit |
|-------|-----------|-----------|
| 1 | 5 | 2 |
| 2–4 | 4 | 1 |

Budget constraints mined and enforcing after round 1 (3 successes + 2 failures in one batch provides immediate evidence).

**Constraint surfacing** (config-repair task, one mined rule — *Edit requires a fresh Read since the last successful Edit* — 6 trials per condition). Every condition carries the same rule; they differ in when the agent hears it and whether the gate also denies. Wasted calls are tool calls that failed or were denied.

| Agent hears the rule... | Gate denies | Wasted calls / trial | Trials that batched 5 Edits |
|---|---|---|---|
| never | no | 4.5 | 5/6 |
| after a failure | no | 4.0 | 6/6 |
| in the denial | yes | 3.0 (all denials) | 4/6 |
| before a turn, only when the trajectory says the next call would be denied | yes | 3.3 | 5/6 |
| same, without the gate | no | 3.3 | 5/6 |
| every turn, as a standing rule | yes | **0.0** | 0/6 |
| same, without the gate | no | **0.3** | 0/6 |

Announced vs denial-only: p = 0.005, d = −2.7. Trajectory-gated hints vs denial-only: not significant, about 10% more tokens. The baseline agent reads once and emits five Edits in one turn; the first Edit invalidates the Read and the rest fail. Only the standing announcement prevents the batch. All 42 trials completed the task, so the gain is in wasted calls, not task success.

</details>

---

<details>
<summary><strong>Appendix C: Research Landscape and Prior Art</strong></summary>

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

Trellis's lineage is most directly Declare monitoring (temporal monitor over event stream) + Declare mining (discover constraints from observed patterns) + ANNEAL (structural repair: discovered constraints prevent recurrence).

### The Declare Miner parallel

The Declare Miner counts **activations** (tool called) and **fulfillments** (prerequisite met) vs **violations** (prerequisite absent), computes confidence, and applies a support threshold. Trellis does the same: count failures-without vs successes-with, apply `minEvidence`. The mechanisms are identical; the domain is different (agent tool calls instead of business process events).

### Systems comparison

| System | What it does | Gap Trellis fills |
|--------|-------------|-------------------------|
| **Declare Miner** [16] | Mines LTLf constraints from event logs | Offline batch analysis; no inline enforcement |
| **Declare Monitor** [17] | Evaluates LTLf over live event streams | Enforces but doesn't discover |
| **ANNEAL** [7] | Recurring failures → symbolic patches | Bespoke system, not an SDK primitive |
| **AGrail** [6] | Adaptive safety with transferable memory | LLM in enforcement path (non-deterministic) |
| **Agent-C** [1] | DSL + SMT temporal constraints | Human-authored only, no discovery |
| **Invariant Labs** [3] | Trace-level policy enforcement | Static rules, no adaptation |

Trellis is the first system to combine Declare-style monitoring with Declare-style constraint mining in a single in-loop primitive for agent execution, mining both temporal and stateless behavioral constraints from the same observation stream.

</details>

---

<details>
<summary><strong>Appendix D: Relationship to Cedar</strong></summary>

| Dimension | CedarAuthorization | Trellis |
|-----------|-------------------|-------|
| **Language** | Cedar | Typed JSON (exports to Dogwood/Cedar/OPA) |
| **Question** | Who can call what? | Is it safe to call now, given history? |
| **Statefulness** | Stateless per-request | Stateful over event history |
| **Policies** | Authored | Authored + discovered |
| **LLM in hot path?** | No | No |

CedarAuthorization and Trellis are the same pattern at different levels:
- **CedarAuthorization** evaluates Cedar policies (stateless authz) on `beforeToolCall`
- **Trellis** evaluates typed JSON constraints (behavioral, temporal and stateless) on `beforeToolCall`, exports to Dogwood/Cedar/OPA

The handlers compose naturally: Cedar answers "is this user allowed?", Trellis answers "is it safe given what already happened?" Mined constraints can be exported to Dogwood for infrastructure-level temporal enforcement.

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
| `request` | `beforeToolCall` | Decision point, triggers authorization |
| `resolution` | `afterToolCall` | History-only: records outcome for temporal queries |

### Constraint types as Dogwood policies

**Prerequisites**: `charge` requires prior `authenticate`:

```cedar
forbid(principal, action == Action::"charge", resource)
unless temporal {
  formerly Action::"authenticate"::request{
    __cedar_principal: principal
  }
};
```

**Budgets**: max 3 charges per session:

```cedar
forbid(principal, action == Action::"charge", resource)
when temporal {
  count(Action::"charge"::request{__cedar_principal: principal}) >= 3
};
```

**Cascades**: block `promote` after `deploy` failure:

```cedar
forbid(principal, action == Action::"promote", resource)
when temporal {
  formerly Action::"deploy"::resolution{
    __cedar_principal: principal,
    output.error: true
  }
};
```

**Loops**: block repeated identical calls:

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
<summary><strong>Appendix E: Future Mining Targets</strong></summary>

Not yet implemented:

| Pattern | Signal | Typed JSON form | Temporal? |
|---------|--------|-----------------|-----------|
| **Input-value** | Tool fails when `amount > N` | `{ type: 'input_guard', tool, field, op, value }` | No |
| **Resource-specific** | Tool fails on resource Y but succeeds on others | `{ type: 'forbid', tool, resource: 'Y' }` | No |
| **Sequence** | Tool C fails unless A then B in order | `{ type: 'sequence', tool, requires: ['A', 'B'] }` | Yes |

</details>

---

<details>
<summary><strong>Appendix F: When LLM Extraction Helps (and When It's Harmful)</strong></summary>

The key principle: **only mine constraints the agent could have prevented by acting differently.** If no sequence of agent actions would have avoided the failure, it's not a constraint — it's an outage.

| Scenario | Agent-preventable? | Correct behavior |
|----------|-------------------|------------------|
| "Authenticate before charge" | Yes — agent can call authenticate first | Mine it |
| "Amount > 1000 requires approval" | Yes — agent can request approval first | Mine it |
| GitHub returning 503 | No — nothing the agent does fixes GitHub | Don't mine |
| Flaky third-party API | No — retrying randomly succeeds | Don't mine |
| "submission rejected" (needs session activation) | Yes — agent can activate first | Mine it |

Deterministic mining handles this naturally: transient failures never produce causal confirmation (there's no "do X first and it works" signal). LLM extraction is more dangerous because a model can look at repeated 503s and propose "don't call GitHub." The evidence pipeline catches this (no success-with-condition to confirm), but the extraction prompt should filter for agent-preventable failures upfront.

LLM extraction earns its value for:
- **Semantic error interpretation**: parsing "submission rejected" into "needs session activation" (the miner can't read error messages)
- **Input-value constraints**: "amount > 1000 requires approval" (the miner doesn't inspect input fields)
- **Silent corruption**: tool returned 200 but downstream broke (no error signal for the miner)

</details>

---

<details>
<summary><strong>Appendix G: FAQ</strong></summary>

### Why not just use RL?

Three reasons: (1) You can't fine-tune API models. Most agents call Claude or GPT via an API with no training access. Trellis operates at inference time. (2) Even a well-trained RL policy violates constraints probabilistically. For "locks your account on the 4th call," 2% isn't good enough. Trellis is a hard gate. (3) RL requires you to define the reward signal before training. The whole point is you don't know the constraints yet.

Trellis does the same *discovery* step as ICRL [14] (infer constraints from observations) but enforces externally rather than baking them into weights. No training loop required.

### Isn't this just a rules engine?

Yes, plus automatic rule discovery. A rules engine needs someone to author the rules. Trellis mines them from failures. The enforcement path is deliberately simple (set membership, counter checks) because the value is in discovery and transfer, not in a novel evaluation engine.

### Why is the default evidence threshold 3?

A single failure could be transient (network timeout, service restart, flaky API). Three failures with the same missing precondition and one success confirming the precondition is enough to distinguish signal from noise. Configurable via `minEvidence`: set to 1 for aggressive mining in controlled environments, higher for noisy ones.

### What about transient failures? Won't it mine noise?

The causal confirmation requirement prevents this. A constraint only promotes when: (1) the tool fails N times without condition X, AND (2) it succeeds at least once with condition X. Random timeouts don't produce the success-with-condition signal, so they never mine.

### What happens when it's wrong?

The demotion cascade. If a human overrides a mined constraint repeatedly, it demotes from enforcing → advisory → retired. Constraints can also be manually retired. See Appendix A.

### How do I debug a blocked call?

Every denial carries: the constraint (typed JSON), its source (`authored` or `discovered`), evidence counts (`{ failures: 3, successes: 1 }`), and a human-readable reason string. `trellis.getConstraintRecords()` returns the full set for inspection.

### Does the observation buffer grow forever?

In the current implementation, yes (bounded by session length). For long-running agents, a sliding window or summarization strategy is future work. In practice, agent sessions are short enough that unbounded observation is fine.

### Multi-tenant: if user A's failures mine a constraint, does it block user B?

Constraints are scoped to the Trellis instance. If you share a single instance across users (via persistent state), mined constraints apply to all. For multi-tenant, either scope instances per-tenant or include principal in the constraint (the `forbid` type supports an optional `principal` field). Cross-tenant transfer is opt-in, not default.

### How does this compose with Cedar?

They're independent handlers in the interventions array. Cedar answers "is this user allowed?" (stateless authz). Trellis answers "is it safe given what already happened?" (stateful behavioral). Both can deny the same call for different reasons. If you pass a CedarAuthorization as Trellis's `policy`, that's a different pattern: Trellis delegates enforcement to Cedar as a private child.

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

[14] Malik, Anwar, Aghasi, Ahmed, "Inverse Constrained Reinforcement Learning," ICML 2021.

[15] Weil-Kennedy et al., "Runtime Verification of Interactions Using Automata," arXiv 2511.00531, 2025.

[16] Maggi, Mooij, van der Aalst, "User-Guided Discovery of Declarative Process Models," CIDM 2011.

[17] De Giacomo, De Masellis, Maggi, Montali, "Monitoring Constraints and Metaconstraints with Temporal Logics on Finite Traces," arXiv 2004.01859, 2020.

[18] Dogwood Policy Language, github.com/dogwood-policy/dogwood.

[19] Lou et al., "Deriving Semantic Checkers from Tests to Detect Silent Failures in Production Distributed Systems," USENIX OSDI 2025.

[20] Havelund, Peled, Ulus, "DejaVu: A Monitoring Tool for First-Order Temporal Logic," github.com/havelund/dejavu.

</details>
