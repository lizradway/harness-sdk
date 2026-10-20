---
name: docs-verifier
description: Exhaustively verify a documentation page against the repo source — every code example and every factual claim in the prose (names, signatures, defaults, numbers, behavior, language availability, commands, links) traced to the line of code that proves it, with code blocks type-checked or run. Use before merging a docs PR, after an SDK or harness change that may have made pages stale, or whenever a page must be correct down to the last detail. Also triggers on "verify this page", "fact-check the docs", "is this doc accurate", "check the docs against the code", "are these examples up to date".
---

# Documentation Verifier

Verify that everything a documentation page states is true of the code in this repo right now. Produces a claim-by-claim report where every verdict cites the `file:line` that backs it.

**How this differs from the other docs skills:** `docs-reviewer` checks voice and style. `docs-audit` decides whether a page needs work, and accuracy is one of five things it skims. `docs-verifier` checks nothing but truth, and checks all of it: every code block, every parameter, every default, every number, every behavioral sentence. It ignores voice, structure, and terminology entirely.

**The source is the source of truth.** Where the page and the code disagree, the page is wrong. Never edit SDK or harness code to match a docs claim.

## Inputs

- **Target**: one or more pages under `site/src/content/docs/`, or a docs PR / branch. To scope to a branch, list changed pages with `git diff --name-only origin/main... -- site/src/content/docs`.
- **Stale-page sweep** (optional): given a code change, find the pages that describe it. Search `sourceLinks` and prose for the changed paths and symbols: `grep -rn "<changed/path>\|<SymbolName>" site/src/content/docs`.

## Where the truth lives

Everything is in this monorepo. Read source from disk; no clones are needed.

| Area | Source | Public surface |
|------|--------|----------------|
| Python SDK (`strands-agents`) | `strands-py/src/strands/` | `__all__` of the imported module |
| TypeScript SDK (`@strands-agents/sdk`) | `strands-ts/src/` | `strands-ts/src/index.ts` barrel (`@internal` is not public) |
| Python harness (`strands-harness`) | `harness-py/src/strands_harness/` | `harness-py/src/strands_harness/__init__.py` |
| TypeScript harness (`@strands-agents/harness`) | `harness-ts/src/` | `harness-ts/src/index.ts` (`./internal` is not public) |
| CLI (`@strands-agents/cli`) | `strands-cli/src/` | its command definitions under `strands-cli/src/cli/` |

For orientation in the SDKs, use the key-module map in `../../references/code-verification.md`; skip its clone and GitHub API tiers, since the source is already on disk. Tests (`*/test/`, `*/tests/`) and `strands-ts/examples/` are supporting evidence for behavior, never a substitute for reading the implementation.

## Process

### Step 1: Resolve the page

1. Record `git rev-parse --short HEAD` and the branch before you start; if HEAD moves during the run, note both revisions in the report.
2. Read the `.mdx` / `.md` file and its frontmatter. Note `languages`, `experimental`, `community`, and `sourceLinks`.
3. Resolve every `--8<-- "path:region"` include. Paths are relative to `site/src/content/docs/`. Open each included `.ts` / `.py` file (and its `_imports` sibling) and confirm the region has a matching `[start:region]` / `[end:region]` pair. A missing region is a finding.
4. Note which code is inlined in the MDX and which comes from snippet files. Inlined code is not covered by any CI check, so it needs the most care in Step 4.

### Step 2: Build the claim inventory

Before verifying anything, list every verifiable unit on the page, numbered, with its line number. Write the inventory first so nothing gets skipped while you are deep in one claim.

**From code blocks** (separately for each language tab and each nested tab, e.g. "Strands harness" vs "SDK"):
- every import and the package it comes from
- every class, function, and method called, and every argument name and value passed
- every attribute read off a result, and every claimed output, printed value, or `Typical output` block
- install commands and package names, including install comments inside a block (`# pip install strands-agents`). The comment is a claim that it installs everything the block needs, extras included
- comments inside a block that assert something (`# No summarizer override in the SDK`); these are claims, not narration

**From prose, tables, and callouts:** every sentence that asserts something checkable. Typical claims:
- names, signatures, parameter types, and return shapes
- defaults ("on by default", "defaults to 3"), numeric limits, timeouts, and TTLs ("cached for 15 minutes")
- behavior and ordering ("runs before the model call", "returns the answer, not the raw page", "retries on throttling")
- error and exception types, and when they are raised
- which language, model provider, or surface supports a feature, including both values of every `<Syntax py="…" ts="…" />`
- environment variables, config keys, and CLI flags
- links to other pages, API reference, or GitHub

**From frontmatter:** each `sourceLinks` path, `languages`, and `experimental`.

Use `fm` as the line for frontmatter claims. For a claim repeated across the page, inventory it once and list every line it appears on.

List motivation, opinion, and analogy explicitly as "not a claim" so a reader can see the inventory is complete.

### Step 3: Verify each claim against source

For every claim, find the code that decides it and record the `file:line` evidence.

- **Trace behavior, don't infer it.** A function name, docstring, or comment is not evidence that the code does what it says. Follow the actual code path. For numbers, find the constant (e.g. `_CACHE_TTL_SECONDS = 15 * 60`) and every place it is used.
- **Check each language independently.** Python and TypeScript are separate implementations; matching names do not imply matching behavior or defaults. A claim in shared prose must hold in every language the page covers.
- **Check that it is public.** A symbol that exists but is not exported (not in `__all__`, not in the `index.ts` barrel, tagged `@internal`, or only under `./internal`) is a finding even if the example works.
- **Check lifecycle markers.** Look for deprecation warnings, `@deprecated`, and experimental namespaces, and compare them with the page's `experimental` frontmatter and wording.
- **Check the version it ships in.** Readers install published packages, not `main`. Find the commit that introduced a feature (`git log -S '<symbol>' --oneline -- <path>`) and the first release containing it (`git tag --contains <commit> | grep -E '^(python|typescript)/'`). Unreleased behavior described as available is ⚠️. Harness packages depend on the published SDK (`strands-agents` range in `harness-py/pyproject.toml`, `@strands-agents/sdk` range in `harness-ts/package.json`), so a harness page that relies on SDK behavior needs that behavior inside the range.
- **Check `sourceLinks`.** Each path exists, and it is the file that implements what the page describes, not just a related file.
- **Check parity claims.** If the page says both SDKs behave the same, show it for both. If one SDK lacks the feature, the `languages` frontmatter and tabs must say so.

### Step 4: Check the code mechanically

Reading is not enough for code blocks; compile them, and run them when you can. Put scratch files under `.context/` (gitignored) unless a step below says otherwise, and delete any scratch files you create elsewhere when you're done.

**TypeScript snippet files** (included via `--8<--`; skip if the page has none): from `site/`, run

```bash
npm run typecheck:snippets
```

This covers every `.ts` file under `site/src/content/docs/` against the local `strands-ts`. Then check each rendered block on its own: the `_imports` region plus the body region must define everything the body uses, since the lines outside the markers never render.

**Inlined TypeScript:** not covered by `typecheck:snippets`. Copy each block verbatim into a scratch `.ts` file and type-check it against the package it imports from.

*SDK blocks* (`@strands-agents/sdk`): the root `node_modules/@strands-agents/sdk` links to the local `strands-ts`, so a scratch directory anywhere under the repo root resolves it. Build `strands-ts` first (`npm run build` in `strands-ts/`) if `strands-ts/dist/` is missing.

```bash
mkdir -p .context/verify/ts
echo '{ "type": "module" }' > .context/verify/ts/package.json
# write each block to .context/verify/ts/<n>.ts, then add .context/verify/ts/tsconfig.json:
#   { "extends": "../../../strands-ts/tsconfig.base.json",
#     "compilerOptions": { "noEmit": true, "rootDir": ".", "types": [], "noUnusedLocals": false },
#     "include": ["./*.ts"] }
npx tsc -p .context/verify/ts/tsconfig.json
```

*Harness blocks* (`@strands-agents/harness`): it does not resolve from `site/` or the repo root, so check them inside `harness-ts/`, where the package import resolves to its own `dist/`:

```bash
cd harness-ts
npm ci && npm run build          # once
mkdir -p .verify
# write each block to .verify/<n>.ts, then add .verify/tsconfig.json:
#   { "extends": "../tsconfig.base.json",
#     "compilerOptions": { "noEmit": true, "noUnusedLocals": false },
#     "include": ["./*.ts"] }
npx tsc -p .verify/tsconfig.json
rm -rf .verify
```

`harness-ts/node_modules/@strands-agents/sdk` is the published SDK, not the local `strands-ts`. That is correct for harness blocks, but never check an SDK block from inside `harness-ts/`, or you verify it against the wrong code.

**Python** (inlined or `.py` snippet files): no CI check covers these. Run them in a throwaway environment built from the local source:

```bash
uv venv .context/verify-venv
uv pip install --python .context/verify-venv/bin/python -e ./strands-py -e ./harness-py
mkdir -p .context/verify   # write each block to .context/verify/<n>.py
cd .context/verify && ../verify-venv/bin/python <n>.py
```

Install only what the page's install line or comment installs, run the block, and only then add extras. If the block fails until you add an extra the page doesn't mention, the install line is ❌. Run from inside `.context/`, because agents and harnesses can create session or memory directories relative to the working directory.

Most blocks construct an agent and then invoke it. Construction usually needs no credentials, so run the block up to the first model call; it catches wrong imports, parameter names, and types. Use `inspect.signature(...)` to confirm keyword names and defaults the block doesn't exercise.

**Running end to end:** only run a full invocation when it needs no credentials, or when credentials are clearly configured in the environment. Otherwise record the claim as *verified statically, not executed*. Never report a block as run when it was only compiled.

**Shell and CLI commands:** confirm flags and subcommands against the CLI source or `--help`, and package names against `pyproject.toml` / `package.json`. Don't run commands that install globally, deploy, or call paid services just to verify a page.

### Step 5: Check links

- Internal links: the target page exists and actually covers what the linking sentence promises. The site build's broken-link checker (`npm run build`) fails on dead internal links, but it can't tell when a link points at the wrong page.
- Anchors (`#section`): the heading exists on the target page.
- API reference and GitHub links: they point at a real symbol or path on `main`.

### Step 6: Assign verdicts

Every inventory item gets exactly one verdict:

| Verdict | Meaning | Required evidence |
|---------|---------|-------------------|
| ✅ Verified | True as written | `file:line` (and the command, for mechanical checks) |
| ❌ Incorrect | The page says X; the code says Y | `file:line` showing Y, plus a suggested correction |
| ⚠️ At risk | True today, but deprecated, internal, experimental without saying so, true in only one language, unreleased, or working only by accident (e.g. an import that binds a module rather than the documented object, but still happens to work) | `file:line` and what makes it fragile |
| ❓ Unverifiable | No source settles it (e.g. behavior delegated to an external service) | Why, and what would settle it |

Don't round ❓ up to ✅. If you can't prove a claim, say so (see Tier 4 in `../../references/code-verification.md`).

## Output Format

```markdown
## Docs Verification: [Page Title]

**File:** site/src/content/docs/[path]
**Verified against:** [short SHA recorded at the start] on [branch]
**Result:** [N] claims — ✅ [n] · ❌ [n] · ⚠️ [n] · ❓ [n]

### Findings

| # | Line | Claim | Verdict | Evidence | Suggested fix |
|---|------|-------|---------|----------|---------------|
| 7 | 18 | Fetched content is cached for 30 minutes | ❌ | harness-py/src/strands_harness/tools/web_fetch.py:37 sets 15 × 60 s | "cached for 15 minutes" |

[Only ❌, ⚠️, and ❓ rows here, ❌ first. Write "None" if every claim verified.]

### Full Claim Inventory

| # | Line | Claim | Verdict | Evidence |
|---|------|-------|---------|----------|
| 1 | 12 | `web_fetch` and `web_search` are on by default | ✅ | [file:line] |
| … | | | | |

Not claims: [line numbers of motivation/opinion sentences you skipped]

### Commands Run

| Command | Result |
|---------|--------|
| `npm run typecheck:snippets` | pass |
| `python .context/verify/3.py` (construction only, no model call) | pass |
```

The full inventory lets a reviewer audit the verifier, so include it even when there are no findings. For multi-page runs, write one report per page, then a summary table of pages by finding count.

## What This Skill Does NOT Do

- Does not review voice, style, structure, or terminology (use `docs-reviewer` or `docs-audit`).
- Does not edit SDK, harness, or CLI source.
- Does not rewrite the page by default. After the report, offer to apply the ❌ fixes as docs-only edits; make them only if the user agrees.
- Does not commit, push, or open PRs.
