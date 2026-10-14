import { logger } from '../../logging/logger.js'
import type { Storage, StorageSearchResult } from '../storage.js'
import type { SearchStrategy } from './types.js'

/** Split text into a set of lowercased word tokens for keyword matching. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
  )
}

/** Lexical relevance score: distinct query tokens that appear in the content. Returns 0 when there is no overlap. */
export function tokenOverlapScore(queryTokens: Set<string>, content: string): number {
  let score = 0
  for (const token of tokenize(content)) {
    if (queryTokens.has(token)) score++
  }
  return score
}

export const STOP_WORDS = new Set([
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

/**
 * Keyword search strategy using token-overlap scoring.
 *
 * Tokenizes the query and each stored entry (key + content), then scores by the
 * number of distinct query tokens that appear. Works on any storage backend with
 * `list()` and `read()` — no index or embedding model required. Each result includes
 * the bytes read during the scan, so callers do not need to read hits again. Entries
 * whose `read()` throws are skipped and logged at debug level.
 *
 * This is the default search strategy for all shipped storage backends.
 *
 * @example
 * ```typescript
 * import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
 *
 * const results = await KeywordSearchStrategy.search(storage, 'dark mode toggle')
 * ```
 */
export const KeywordSearchStrategy: SearchStrategy = {
  async search(storage: Storage, query: string): Promise<StorageSearchResult[]> {
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []

    const allKeys = await storage.list('')
    const scored: StorageSearchResult[] = []
    for (const key of allKeys) {
      let bytes: Uint8Array | null
      try {
        bytes = await storage.read(key)
      } catch (error) {
        // One unreadable entry (e.g. a permissions error) must not fail the whole search.
        logger.debug(`key=<${key}>, error=<${error}> | skipped unreadable entry`)
        continue
      }
      if (!bytes) continue
      const content = new TextDecoder().decode(bytes)
      const score = tokenOverlapScore(queryTokens, `${key} ${content}`)
      // Return the bytes already read so callers (e.g. FileMemoryStore) need not re-read each hit.
      if (score > 0) scored.push({ key, score, data: bytes })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored
  },
}
