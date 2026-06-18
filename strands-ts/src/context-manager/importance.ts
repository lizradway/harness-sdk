/**
 * Importance-ranked preview construction.
 *
 * An alternative to head/tail truncation that scores each line of a tool result
 * and greedily keeps the highest-scoring lines up to a token budget, preserving
 * original order. Scoring combines three model-free signals:
 *
 * - **structural** — error/anomaly markers and head/tail boundary lines, which
 *   carry the salient information in most tool output (Headroom's "SmartCrusher"
 *   heuristic: keep errors, anomalies, boundaries).
 * - **query overlap** — lexical overlap with the agent's current task and recent
 *   tool inputs, so the lines relevant to what the agent is *looking for* survive
 *   (the model-free analog of LongLLMLingua's question-aware compression).
 * - **position** — a mild head/tail bias as a tie-breaker.
 *
 * This targets the "preview fidelity" failure where lossy head/tail previews
 * discard the lines an agent needs and force it to re-investigate.
 */

/** Approximate characters per token, matching the heuristic used elsewhere in the SDK. */
const CHARS_PER_TOKEN = 4

/** Relative weights for the three importance signals. */
export interface ImportanceWeights {
  /** Weight for error/anomaly/boundary structural salience. */
  structural: number
  /** Weight for lexical overlap with the query. */
  query: number
  /** Weight for the head/tail position bias. */
  position: number
}

/** Default weights: structural-heavy, query-medium, position-light. */
export const DEFAULT_IMPORTANCE_WEIGHTS: ImportanceWeights = {
  structural: 1.0,
  query: 0.6,
  position: 0.25,
}

/** Lines matching this carry error/anomaly signal and are always high-value. */
const ERROR_PATTERN =
  /\b(error|errno|exception|traceback|stack ?trace|panic|fatal|fail(ed|ure)?|warning|warn|assert|denied|refused|timeout|undefined|null pointer|segfault)\b/i

/** Number of leading/trailing lines that get a boundary boost. */
const BOUNDARY_LINES = 3

/** Extract scoring terms from the query: lowercased word-ish tokens of length 3 or more. */
export function queryTerms(query: string | undefined): Set<string> {
  if (!query) return new Set()
  const terms = new Set<string>()
  for (const m of query.toLowerCase().matchAll(/[a-z0-9_]{3,}/g)) {
    terms.add(m[0])
  }
  return terms
}

/** Score a single line against the structural, query, and position signals. */
function scoreLine(line: string, index: number, total: number, terms: Set<string>, w: ImportanceWeights): number {
  let score = 0

  // Structural: error/anomaly lines are the highest-value signal.
  if (ERROR_PATTERN.test(line)) score += w.structural

  // Query overlap: reward any hit strongly, with diminishing returns for more.
  // A single query-relevant line must outrank a generic boundary line.
  if (terms.size > 0) {
    const lower = line.toLowerCase()
    let hits = 0
    for (const t of terms) {
      if (lower.includes(t)) hits++
    }
    if (hits > 0) score += w.query * (0.5 + 0.5 * Math.min(1, (hits - 1) / 2))
  }

  // Position: a weak tie-breaker that nudges the head/tail boundary lines up so
  // the very start and end survive when nothing else distinguishes lines.
  if (index < BOUNDARY_LINES || index >= total - BOUNDARY_LINES) score += w.position

  return score
}

/**
 * Build an importance-ranked preview of `text` within `tokens` token budget.
 *
 * Lines are scored, the highest-scoring kept greedily until the budget is spent,
 * then re-emitted in original order with `… [N lines elided] …` markers where
 * runs were dropped. Falls back to returning the whole text when it already fits.
 *
 * @param text - The full content to preview.
 * @param tokens - Target token budget for the preview.
 * @param query - Optional task/query text used for the overlap signal.
 * @param weights - Optional signal weights (defaults to {@link DEFAULT_IMPORTANCE_WEIGHTS}).
 */
export function importancePreview(
  text: string,
  tokens: number,
  query?: string,
  weights: ImportanceWeights = DEFAULT_IMPORTANCE_WEIGHTS
): string {
  const maxChars = Math.max(0, tokens) * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text

  const lines = text.split('\n')
  const total = lines.length
  const terms = queryTerms(query)

  const scored = lines.map((line, index) => ({
    index,
    line,
    score: scoreLine(line, index, total, terms, weights),
    cost: line.length + 1,
  }))

  // Greedily select highest-scoring lines (ties broken by original order) until
  // the budget is spent.
  const order = [...scored].sort((a, b) => b.score - a.score || a.index - b.index)
  const keep = new Set<number>()
  let used = 0
  for (const s of order) {
    if (used + s.cost > maxChars) continue
    keep.add(s.index)
    used += s.cost
    if (used >= maxChars) break
  }

  // Emit kept lines in original order, collapsing dropped runs into markers.
  const out: string[] = []
  let elided = 0
  for (let i = 0; i < total; i++) {
    if (keep.has(i)) {
      if (elided > 0) {
        out.push(`… [${elided} line${elided === 1 ? '' : 's'} elided] …`)
        elided = 0
      }
      out.push(lines[i]!)
    } else {
      elided++
    }
  }
  if (elided > 0) out.push(`… [${elided} line${elided === 1 ? '' : 's'} elided] …`)

  return out.join('\n')
}
