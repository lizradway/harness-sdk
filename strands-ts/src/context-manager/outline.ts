/**
 * Structural outlines for tool-result content.
 *
 * When a large tool result is offloaded, the inline replacement should be a
 * *faithful* outline of what was offloaded — its "table of contents" — rather
 * than a lossy positional or heuristic slice. The outline tells the agent the
 * true shape of the content so it can retrieve precisely on demand instead of
 * re-investigating blindly.
 *
 * This module provides {@link detectContentType} (a deterministic, model-free
 * content sniffer) and the structured outliners for grep output, directory
 * listings, and tabular data. Code (`skeleton`) and JSON (`schema-only`) are
 * handled by their existing methods; unstructured prose has no faithful outline
 * and is left to lean offload + on-demand retrieval.
 */

/** Content shapes the dispatcher can produce a faithful outline for. */
export type DetectedContent = 'json' | 'grep' | 'tree' | 'table' | 'code' | 'unstructured'

/** A line like `path/to/file.ts:42:` or `path:42:53:` from grep/ripgrep. */
const GREP_LINE = /^[\w./~-]+:\d+:/
/** A bare path-ish line (dir listing / find output). */
const PATH_LINE = /^[\w./~-]+\/[\w.@-]+\/?$|^[./][\w./@-]+$/
/** An `ls -l` style row: perms, links, owner, ... name. */
const LS_LONG_LINE = /^[bcdlps-][rwxsStT-]{9}[ @+.]?\s+\d+\s/
/** Hint tokens that suggest source code. */
const CODE_TOKEN = /\b(function|class|def|import|export|const|return|public|private|func|fn|struct|impl)\b/

/** Fraction of sampled lines that must match a pattern to classify by it. */
const MATCH_FRACTION = 0.6
/** Max lines sampled when classifying, for speed on huge inputs. */
const SAMPLE_LINES = 200

/** Returns the fraction of non-empty sampled lines matching `re`. */
function lineMatchRatio(lines: string[], re: RegExp): number {
  const sample = lines.slice(0, SAMPLE_LINES).filter((l) => l.trim().length > 0)
  if (sample.length === 0) return 0
  let hits = 0
  for (const l of sample) if (re.test(l)) hits++
  return hits / sample.length
}

/** Detect the consistent single-char delimiter of tabular data, or undefined. */
function detectDelimiter(lines: string[]): string | undefined {
  const sample = lines.slice(0, SAMPLE_LINES).filter((l) => l.trim().length > 0)
  if (sample.length < 2) return undefined
  for (const delim of [',', '\t', '|']) {
    const counts = sample.map((l) => l.split(delim).length - 1)
    const first = counts[0]!
    // Consistent (>=1 delimiter, same count on every sampled line) → tabular.
    if (first >= 1 && counts.every((c) => c === first)) return delim
  }
  return undefined
}

/**
 * Classify tool-result text into a {@link DetectedContent} shape. Deterministic
 * and model-free; ordered most-specific-first. Only *routes* to a downstream
 * outliner — it never decides which lines are important.
 *
 * @param text - The raw tool-result text.
 * @param hintPath - Optional file path from the tool input (e.g. a read_file
 *   argument), used as a code hint via its extension.
 */
export function detectContentType(text: string, hintPath?: string): DetectedContent {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'unstructured'

  // JSON: a parse that yields an object/array is unambiguous.
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') return 'json'
    } catch {
      // not JSON, fall through
    }
  }

  const lines = trimmed.split('\n')

  if (lineMatchRatio(lines, GREP_LINE) >= MATCH_FRACTION) return 'grep'
  if (lineMatchRatio(lines, LS_LONG_LINE) >= MATCH_FRACTION) return 'tree'
  if (lineMatchRatio(lines, PATH_LINE) >= MATCH_FRACTION) return 'tree'
  if (detectDelimiter(lines) !== undefined) return 'table'

  // Code: a file-extension hint, or a high density of code tokens.
  if (hintPath && CODE_EXTENSIONS.test(hintPath)) return 'code'
  if (lineMatchRatio(lines, CODE_TOKEN) >= 0.25) return 'code'

  return 'unstructured'
}

/** File extensions that indicate source code, for the `hintPath` signal. */
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|swift|kt|scala|sh|pony|ml|ex|exs)$/i

/** Truncate a list to `max`, appending a count of how many were elided. */
function capList(items: string[], max: number): string[] {
  if (items.length <= max) return items
  return [...items.slice(0, max), `… [${items.length - max} more]`]
}

/**
 * Outline grep/ripgrep output: keep the `file:line` match locations, drop the
 * matched line content and surrounding context. Tells the agent *where* the
 * matches are so it can read the precise spans on demand.
 *
 * @param text - Raw grep output.
 * @param maxMatches - Maximum match locations to list. Defaults to 100.
 */
export function grepOutline(text: string, maxMatches = 100): string {
  const locs: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^([\w./~-]+:\d+):/)
    if (m) locs.push(m[1]!)
  }
  if (locs.length === 0) return text
  const files = new Set(locs.map((l) => l.slice(0, l.lastIndexOf(':'))))
  const header = `[grep outline: ${locs.length} matches across ${files.size} file(s)]`
  return [header, ...capList(locs, maxMatches)].join('\n')
}

/**
 * Outline a directory listing: keep the paths, drop sizes/dates/permissions.
 *
 * @param text - Raw `ls`/`find`/tree output.
 * @param maxEntries - Maximum entries to list. Defaults to 200.
 */
export function treeOutline(text: string, maxEntries = 200): string {
  const entries: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim().length === 0) continue
    // ls -l: perms links owner group size month day time NAME — skip 8 fields.
    const ls = line.match(/^[bcdlps-][rwxsStT-]{9}[ @+.]?\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/)
    entries.push(ls ? ls[1]! : line.trim())
  }
  if (entries.length === 0) return text
  const header = `[directory outline: ${entries.length} entries]`
  return [header, ...capList(entries, maxEntries)].join('\n')
}

/**
 * Outline tabular (CSV/TSV/pipe) data: keep the header and inferred column
 * types with a row count, drop the rows.
 *
 * @param text - Raw delimited text.
 */
export function tableOutline(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return text
  const delim = detectDelimiter(lines)
  if (delim === undefined) return text
  const header = lines[0]!.split(delim).map((h) => h.trim())
  const rows = lines.slice(1)
  const sample = rows[0]?.split(delim) ?? []
  const cols = header.map((name, i) => `${name}: ${inferCellType(sample[i])}`)
  return [`[table outline: ${rows.length} rows × ${header.length} cols]`, ...cols].join('\n')
}

/** Infer a coarse cell type for a tabular column sample. */
function inferCellType(cell: string | undefined): string {
  if (cell === undefined || cell.trim() === '') return 'empty'
  const t = cell.trim()
  if (/^-?\d+$/.test(t)) return 'int'
  if (/^-?\d*\.\d+$/.test(t)) return 'float'
  if (/^(true|false)$/i.test(t)) return 'bool'
  return 'string'
}
