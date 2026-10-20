---
name: docs-verifier
description: Verify every code example and factual claim on a documentation page against the source, citing the line that proves each one and type-checking or running the code. Use before merging a docs PR, or when asked to verify or fact-check a page.
---

# Documentation Verifier

Verify that everything a documentation page states is true of the code in this repo right now. Produces a claim-by-claim report where every assessment cites the `file:line` that backs it.

**How this differs from the other docs skills:** `docs-reviewer` checks voice and style. `docs-audit` decides whether a page needs work, and accuracy is one of five things it skims. `docs-verifier` checks nothing but truth, and checks all of it: every code block, every parameter, every default, every number, every behavioral sentence. It ignores voice, structure, and terminology entirely.

**The source is the source of truth.** Where the page and the code disagree, the page is wrong. Never edit SDK or harness code to match a docs claim.

## Inputs

- **Target**: the pages to verify. Verify exactly the pages you're given and nothing else; one or two named pages is the normal case. Accepted forms:
  - one or more page paths under `site/src/content/docs/` (or their published URLs)
  - a docs PR or branch: verify only its changed pages, listed with `git diff --name-only origin/main... -- site/src/content/docs`
  - a code change: verify the pages that describe it, found by searching `sourceLinks` and prose for the changed paths and symbols (`grep -rln "<changed/path>\|<SymbolName>" site/src/content/docs`)
- **No target given:** ask which pages to verify. Never default to the whole site; a full sweep happens only when explicitly requested.

## Where the truth lives

These packages live in this monorepo; read their source from disk.

| Area | Source | Public surface |
|------|--------|----------------|
| Python SDK (`strands-agents`) | `strands-py/src/strands/` | `__all__` of the imported module |
| TypeScript SDK (`@strands-agents/sdk`) | `strands-ts/src/` | `strands-ts/src/index.ts` barrel (`@internal` is not public) |
| Python harness (`strands-harness`) | `harness-py/src/strands_harness/` | `harness-py/src/strands_harness/__init__.py` |
| TypeScript harness (`@strands-agents/harness`) | `harness-ts/src/` | `harness-ts/src/index.ts` (`./internal` is not public) |
| CLI (`@strands-agents/cli`) | `strands-cli/src/` | command definitions under `strands-cli/src/cli/`; in-chat slash commands in `strands-cli/src/tui/chat/commands.ts` |
| MCP server (`strands-agents-mcp-server`) | `strands-mcp/src/strands_mcp_server/` | its registered MCP tools |

**Not in this repo:** pages under `user-guide/evals-sdk/` (`strands-agents/evals`), `user-guide/box/` (`strands-agents/box`), and `user-guide/shell/` (`strands-agents/shell`) document packages whose source lives in other repos. Shallow-clone the repo into `.context/` (`git clone --depth 1 https://github.com/strands-agents/<repo> .context/src/<repo>`) or read it through the GitHub API (`gh api repos/strands-agents/<repo>/contents/<path>`), and cite `<repo>/<path>:line` as evidence. Never mark a claim `correct` from a package or install name alone.

For orientation in the SDKs, use the **Key Python modules** and **Key TypeScript modules** lists in `../../references/code-verification.md` (paths relative to `strands-py/src/strands/` and `strands-ts/src/`). Tests (`*/test/`, `*/tests/`) and `strands-ts/examples/` are supporting evidence for behavior, never a substitute for reading the implementation.

## Process

### Step 1: Resolve the page

1. Record `git rev-parse --short HEAD` and the branch before you start; if HEAD moves during the run, note both revisions in the report.
2. Read the `.mdx` / `.md` file and its frontmatter. Note `languages`, `experimental`, `community`, and `sourceLinks`. An absent `languages` field means the page covers both SDKs; `site/src/content.config.ts` rejects one that lists both.
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
- **Check that it is public.** A symbol that exists but is not exported (not in `__all__`, not in the `index.ts` barrel, tagged `@internal`, or only under `./internal`) gets the `internal` tag even if the example works.
- **Check lifecycle markers.** Look for deprecation warnings, `@deprecated`, and experimental namespaces, and compare them with the page's `experimental` frontmatter and wording.
- **Check the version it ships in.** Readers install published packages, not `main`. Find the commit that introduced a feature (`git log -S '<symbol>' --oneline -- <path>`) and the first release containing it (`git tag --contains <commit> | grep -E '^python/v[0-9]' | sort -V | head -1`). All packages share history, so always filter to the tag prefix of the package the page documents: `python/`, `typescript/`, `harness-python/`, `harness-typescript/`, `harness-cli/`, or `mcp/`. Search for the line that exports the symbol (the `index.ts` barrel or `__init__.py`), since `git log -S` on the current file path can land on a later move instead of the first release. Behavior not yet in a release gets the `unreleased` tag. Harness packages depend on the published SDK (`strands-agents` range in `harness-py/pyproject.toml`, `@strands-agents/sdk` range in `harness-ts/package.json`), so a harness page that relies on SDK behavior needs that behavior inside the range.
- **Check `sourceLinks`.** Each path exists, and it is the file that implements what the page describes, not just a related file.
- **Check parity claims.** If the page says both SDKs behave the same, show it for both. If one SDK lacks the feature, the `languages` frontmatter and tabs must say so.

### Step 4: Check the code mechanically

Reading is not enough for code blocks; compile them, and run them when you can. Put scratch files under `.context/` unless a step below says otherwise. `.context/` is not gitignored, so remove everything you create when you're done (Step 7).

**TypeScript snippet files** (included via `--8<--`; skip if the page has none): install in the same order as `.github/workflows/docs-ci.yml`, then type-check from `site/`:

```bash
(cd site && npm ci)
(cd strands-ts && npm install --ignore-scripts && npm run build)
(cd site && npm install)        # re-links the built SDK
(cd site && npm run typecheck:snippets); echo "exit=$?"
```

Record the exit code. `tsc: not found` (exit 127) means the dependencies aren't installed, not that the snippets pass. Don't install inside `site/test-snippets/`; it has no lockfile, so `npm ci` there fails. The check type-checks every snippet file on the site, so a failure elsewhere doesn't fail this page: report only errors in this page's snippet files, and note that others exist. Confirm this page's files were included with `npx tsc -p site/test-snippets --listFiles | grep <page-dir>`.

Then check each rendered block on its own: the `_imports` region plus the body region must define everything the body uses, since the lines outside the markers never render. Type-check each rendered block verbatim, imports region plus body region. A region that opens a class or function but ends before it closes is `incorrect`, because the reader copies a block that doesn't compile. If several regions are meant to be read as one piece (e.g. a class body and a method shown separately), also check them combined, and note in the evidence which check each result came from.

**Inlined TypeScript:** not covered by `typecheck:snippets`. Flagging the inlining itself as a break from the snippet convention is `docs-audit`'s job; here, only check whether the code is correct. Copy each block verbatim into a scratch `.ts` file and type-check it against the package it imports from.

*SDK blocks* (`@strands-agents/sdk`): the root `node_modules/@strands-agents/sdk` links to the local `strands-ts`, so a scratch directory anywhere under the repo root resolves it. Build `strands-ts` first (`npm run build` in `strands-ts/`) if `strands-ts/dist/` is missing.

```bash
mkdir -p .context/verify/ts
echo '{ "type": "module" }' > .context/verify/ts/package.json
# write each block to .context/verify/ts/<n>.ts, then add .context/verify/ts/tsconfig.json:
#   { "extends": "../../../strands-ts/tsconfig.base.json",
#     "compilerOptions": { "noEmit": true, "rootDir": ".", "types": ["node"], "noUnusedLocals": false },
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
uv venv --clear .context/verify-venv   # --clear: never reuse a stale venv
uv pip install --python .context/verify-venv/bin/python -e ./strands-py   # SDK pages
# harness pages instead: -e ./harness-py, which pulls the published strands-agents
mkdir -p .context/verify   # write each block to .context/verify/<n>.py
cd .context/verify && ../verify-venv/bin/python <n>.py
```

Install only the package the page documents. Harness blocks then run against the published SDK their dependency range allows, as in the TypeScript harness recipe, and SDK blocks don't inherit the `strands-agents[otel]` extra that `harness-py` pulls in. Start with only what the page's install line or comment installs, run the block, and only then add extras. If the block fails until you add an extra the page doesn't mention, the install line is `incorrect` with `high` impact. Run from inside `.context/`, because agents and harnesses can create session or memory directories relative to the working directory.

Most blocks construct an agent and then invoke it. Construction usually needs no credentials, so run the block up to the first model call; it catches wrong imports, parameter names, and types. Use `inspect.signature(...)` to confirm keyword names and defaults the block doesn't exercise.

**Code that calls an external system** (a CLI binary, a VM, a remote host): put a stub on `PATH` that stands in for it, so the rest of the block runs for real. For example, a fake `fc-exec` that drops its VM argument and runs the remaining command locally lets a custom-sandbox sample run end to end. Say in the evidence that a stub was used. To probe for hangs, use in-language timeouts (`asyncio.wait_for`, `Promise.race`); macOS has no `timeout` command.

**Running end to end:** only run a full invocation when it needs no credentials, or when credentials are clearly configured in the environment. Otherwise record how far you got (`read` or `compiled`) in the claim's *Checked by* field. Never report a block as `executed` when it was only compiled.

**Shell and CLI commands:** confirm flags and subcommands against the CLI source or `--help`, and package names against `pyproject.toml` / `package.json`. Don't run commands that install globally, deploy, or call paid services just to verify a page.

### Step 5: Check links

- Internal links: the target page exists and actually covers what the linking sentence promises. The site build's broken-link checker (`npm run build`) fails on dead internal links, but it can't tell when a link points at the wrong page.
- Anchors (`#section`): the heading exists on the target page.
- API reference links: they point at a real, public symbol. The `site/src/content/docs/api/*/_generated` pages are symlinks into the gitignored `site/.build`, so run `npm run sdk:generate` from `site/` before checking them on disk.
- GitHub links: they point at a real path on `main`.

### Step 6: Assess each claim

Record each claim on four separate fields. Keep them separate: a claim can be correct and still fragile, or wrong in a way that barely matters.

**Accuracy** (every claim, exactly one value):

| Value | Meaning | Required evidence |
|-------|---------|-------------------|
| `correct` | True as written | `file:line` |
| `incorrect` | The page says X; the code says Y | `file:line` showing Y, plus a suggested correction |
| `incomplete` | True only under a condition the page leaves out, or true for some cases the page generalizes to all ("the summarizer uses the provider's small model" when only some providers map one) | `file:line` of the condition or the exception, plus the qualifier to add |
| `unverifiable` | No source settles it (e.g. behavior delegated to an external service) | Why, and what would settle it |

Don't round `unverifiable` up to `correct`. If you can't prove a claim, say so.

**Impact** (only for claims that aren't `correct`): what happens to a reader who trusts the page.

| Value | Meaning | Examples |
|-------|---------|----------|
| `high` | Copied code fails, or the reader acts on wrong behavior | wrong import or parameter, missing install extra, wrong default the reader relies on |
| `medium` | Misleading, but the reader recovers by trying or reading further | overgeneralized behavior, link to a page that doesn't cover the topic, wrong error type |
| `low` | Hygiene; no reader is misled | incomplete `sourceLinks`, prose naming a language-specific identifier without `<Syntax>` |

**Checked by** (every claim): the strongest check you actually ran.

- `read`: traced in source only
- `compiled`: type-checked or import-checked
- `executed`: ran, at least up to construction

**Risk tags** (any claim, including `correct` ones; zero or more):

- `deprecated`: marked deprecated in source
- `internal`: not in the public surface (see Step 3)
- `unreleased`: on `main` but not in a published release, or outside the dependency range a harness ships with
- `one-language`: holds in one SDK but the page implies both
- `accidental`: works, but not for the reason the page implies (e.g. an import that binds a module rather than the documented object, yet still registers the tool)
- `experimental`: experimental in source, but the page's frontmatter or wording doesn't say so

### Step 7: Clean up

Remove every scratch file, directory, and venv you created. Keep only the saved reports in `.context/docs-verifier/` (see Output Format).

```bash
rm -rf .context/verify .context/verify-venv .context/src harness-ts/.verify
git status --short   # nothing new from this run except .context/docs-verifier/
```

## Output Format

```markdown
## Docs Verification: [Page Title]

**File:** site/src/content/docs/[path]
**Verified against:** [short SHA recorded at the start] on [branch]
**Result:** [N] claims, [n] findings: [n] high · [n] medium · [n] low · [n] unverifiable · [n] risk-tagged

### Findings

| # | Line | Claim | Accuracy | Impact | Tags | Checked by | Evidence | Suggested fix |
|---|------|-------|----------|--------|------|------------|----------|---------------|
| 8 | 13 | `web_fetch` and `web_search` are both on by default | incorrect | high | | executed | harness-py/src/strands_harness/agent.py:121-139 turns `web_search` off when the model has no native search, and the default Bedrock model has none | "`web_search` turns on only where the provider has native search" |
| 32 | 62 | `from strands.vended_tools import web_fetch` imports the tool | correct | | accidental | executed | binds the module; `Agent` still registers the tool by scanning it | `from strands.vended_tools.web_fetch import web_fetch` |

[Rows for every claim that isn't `correct`, plus every risk-tagged claim. Sort by impact (high, medium, low), then unverifiable, then risk-tagged correct claims. Write "None" if no row qualifies.]

### Full Claim Inventory

| # | Line | Claim | Accuracy | Checked by | Evidence |
|---|------|-------|----------|------------|----------|
| 14 | 20-21 | Fetched content is cached for 15 minutes | correct | read | harness-py/src/strands_harness/tools/web_fetch.py:37 (`15 * 60`), used at :182, :189 |
| … | | | | | |

Not claims: [line numbers of motivation/opinion sentences you skipped]

### Commands Run

| Command | Result |
|---------|--------|
| `npm run typecheck:snippets` | pass |
| `cd .context/verify && ../verify-venv/bin/python 3.py` (construction only, no model call) | pass |
```

The full inventory lets a reviewer audit the verifier, so include it even when there are no findings. For multi-page runs, write one report per page, then a summary table of pages by high / medium / low finding counts. Save each report to `.context/docs-verifier/<page-slug>.md` and also return it in your reply.

## What This Skill Does NOT Do

- Does not review voice, style, structure, or terminology (use `docs-reviewer` or `docs-audit`).
- Does not edit SDK, harness, or CLI source.
- Does not rewrite the page by default. After the report, offer to apply the suggested fixes as docs-only edits, highest impact first; make them only if the user agrees.
- Does not commit, push, or open PRs.
