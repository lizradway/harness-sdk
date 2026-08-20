import type { Storage, StorageSearchResult } from '../storage.js'
import type { SearchStrategy } from './types.js'

import { isFileSystemStorage } from '../storage.js'

/** Configuration for {@link QmdSearchStrategy}. */
export interface QmdSearchStrategyConfig {
  /** Path to the SQLite database file for the QMD index. Defaults to `.qmd-index.sqlite` inside the storage directory. */
  dbPath?: string
  /** Glob pattern for files to index (default: `**\/*.md`). */
  pattern?: string
  /** Max results to return (default: 10). */
  limit?: number
}

/**
 * BM25 full-text search strategy powered by QMD.
 *
 * Maintains a SQLite-backed inverted index over the storage contents and uses
 * BM25 scoring for relevance ranking. Significantly more accurate than naive
 * token-overlap for natural-language queries — accounts for term frequency,
 * inverse document frequency, and document length normalization.
 *
 * Works with {@link LocalFileStorage} — reads `baseDir` from the storage instance
 * to know where files live on disk.
 *
 * Requires `@tobilu/qmd` as a peer dependency.
 *
 * @example
 * ```typescript
 * import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search'
 *
 * // Pass to a memory store or storage that accepts a search strategy:
 * const store = new FileMemoryStore({ search: new QmdSearchStrategy() })
 *
 * // Consumer just calls storage.search():
 * const results = await store.search('authentication flow')
 * ```
 */
export class QmdSearchStrategy implements SearchStrategy {
  private _store: QmdStore | undefined
  private _storagePath: string | undefined
  private readonly _config: QmdSearchStrategyConfig

  constructor(config?: QmdSearchStrategyConfig) {
    this._config = config ?? {}
  }

  /**
   * Searches stored content using BM25 full-text search.
   *
   * Triggers a re-index of the backing filesystem before searching to ensure
   * results reflect the latest writes. For high-throughput workloads, prefer
   * calling {@link update} on a schedule rather than relying on per-search sync.
   *
   * @param storage - A LocalFileStorage instance (reads `baseDir` for the index path)
   * @param query - Natural-language search query
   * @returns Matched keys with BM25 relevance scores, ranked best-first
   * @throws Error if storage is not a LocalFileStorage or `@tobilu/qmd` is not installed
   */
  async search(storage: Storage, query: string): Promise<StorageSearchResult[]> {
    const store = await this._ensureStore(storage)
    await store.update()
    const ftsQuery = buildOrQuery(query)
    if (!ftsQuery) return []
    const limit = this._config.limit ?? 10
    const db = (store.internal as { db: Database }).db
    const rows: FtsRow[] = db
      .prepare(
        `WITH fts_matches AS (
          SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) as bm25_score
          FROM documents_fts WHERE documents_fts MATCH ? ORDER BY bm25_score ASC LIMIT ?
        )
        SELECT d.collection || '/' || d.path as display_path, fm.bm25_score
        FROM fts_matches fm JOIN documents d ON d.id = fm.rowid WHERE d.active = 1
        ORDER BY fm.bm25_score ASC LIMIT ?`
      )
      .all(ftsQuery, limit * 3, limit)
    return rows.map((row) => ({
      key: row.display_path,
      score: Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score)),
    }))
  }

  /**
   * Re-indexes the backing storage directory without performing a search.
   *
   * @param storage - A LocalFileStorage instance
   */
  async update(storage: Storage): Promise<void> {
    const store = await this._ensureStore(storage)
    await store.update()
  }

  /**
   * Closes the QMD store and releases resources (SQLite connection).
   */
  async close(): Promise<void> {
    if (this._store) {
      await this._store.close()
      this._store = undefined
      this._storagePath = undefined
    }
  }

  private async _ensureStore(storage: Storage): Promise<QmdStore> {
    const storagePath = this._resolveStoragePath(storage)
    if (this._store && this._storagePath === storagePath) return this._store
    if (this._store) await this.close()

    const { createStore } = await import('@tobilu/qmd')
    const { resolve, dirname } = await import('node:path')
    const resolvedPath = resolve(storagePath)
    const dbPath = this._config.dbPath ?? resolve(dirname(resolvedPath), `.${resolvedPath.split('/').pop()}-qmd.sqlite`)

    this._store = await createStore({
      dbPath,
      config: {
        collections: {
          storage: { path: resolvedPath, pattern: this._config.pattern ?? '**/*.md' },
        },
      },
    })
    this._storagePath = storagePath
    return this._store
  }

  private _resolveStoragePath(storage: Storage): string {
    if (isFileSystemStorage(storage)) {
      return storage.baseDir
    }
    throw new Error('QmdSearchStrategy requires a FileSystemStorage (e.g. LocalFileStorage)')
  }
}

type QmdStore = import('@tobilu/qmd').QMDStore

interface Database {
  prepare(sql: string): { all(...params: unknown[]): FtsRow[] }
}

interface FtsRow {
  display_path: string
  bm25_score: number
}

// FTS5 has no built-in stop word support and BM25's IDF alone isn't enough for OR queries —
// noise terms still consume LIMIT slots and slow posting list scans. Benchmarked at +14% recall@5
// and 2.3x speed vs no filtering on LOCOMO.
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'dare',
  'ought',
  'used',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'only',
  'own',
  'same',
  'than',
  'too',
  'very',
  'just',
  'because',
  'about',
  'up',
  'its',
  'it',
  'he',
  'she',
  'they',
  'we',
  'you',
  'i',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'our',
  'their',
  'this',
  'that',
  'these',
  'those',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'if',
  'while',
  'although',
  'though',
  'unless',
  'until',
  'since',
])

function buildOrQuery(query: string): string | null {
  const terms = query
    .replace(/[?.,!;:'"()[\]{}]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word.toLowerCase()))
    .map((word) => word.replace(/[^\p{L}\p{N}'_]/gu, '').toLowerCase())
    .filter((word) => word.length > 1)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term}"*`).join(' OR ')
}
