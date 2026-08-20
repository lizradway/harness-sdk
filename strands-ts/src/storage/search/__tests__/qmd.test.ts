import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QmdSearchStrategy } from '../qmd.js'

vi.mock('@tobilu/qmd', () => ({
  createStore: vi.fn(),
}))

vi.mock('node:path', () => ({
  resolve: (...args: string[]) => args.join('/'),
  dirname: (path: string) => path.split('/').slice(0, -1).join('/') || '/',
}))

describe('QmdSearchStrategy', () => {
  const mockPrepare = vi.fn()
  const mockQmdStore = {
    update: vi.fn().mockResolvedValue({
      collections: 1,
      indexed: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      needsEmbedding: 0,
    }),
    searchLex: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    internal: { db: { prepare: mockPrepare } },
  }

  const mockStorage = {
    baseDir: '/tmp/test-storage',
    write: vi.fn(),
    read: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockPrepare.mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    })
    const { createStore } = await import('@tobilu/qmd')
    vi.mocked(createStore).mockResolvedValue(mockQmdStore as never)
  })

  describe('search', () => {
    it('initializes the store from the storage baseDir on first call', async () => {
      const { createStore } = await import('@tobilu/qmd')
      const strategy = new QmdSearchStrategy()

      await strategy.search(mockStorage, 'test query')

      expect(createStore).toHaveBeenCalledWith({
        dbPath: '/tmp/.test-storage-qmd.sqlite',
        config: {
          collections: {
            storage: { path: '/tmp/test-storage', pattern: '**/*.md' },
          },
        },
      })
    })

    it('calls update and queries the FTS index with OR semantics', async () => {
      mockPrepare.mockReturnValue({
        all: vi.fn().mockReturnValue([{ display_path: 'storage/auth.md', bm25_score: -10 }]),
      })
      const strategy = new QmdSearchStrategy()

      const results = await strategy.search(mockStorage, 'authentication flow')

      expect(mockQmdStore.update).toHaveBeenCalled()
      expect(mockPrepare).toHaveBeenCalled()
      const sql = mockPrepare.mock.calls[0]![0]
      expect(sql).toContain('documents_fts MATCH')
      const allFn = mockPrepare.mock.results[0]!.value.all
      expect(allFn).toHaveBeenCalledWith('"authentication"* OR "flow"*', 30, 10)
      expect(results).toEqual([{ key: 'storage/auth.md', score: 10 / 11 }])
    })

    it('respects custom limit', async () => {
      const strategy = new QmdSearchStrategy({ limit: 5 })

      await strategy.search(mockStorage, 'test query')

      const allFn = mockPrepare.mock.results[0]!.value.all
      expect(allFn).toHaveBeenCalledWith(expect.any(String), 15, 5)
    })

    it('uses custom pattern', async () => {
      const { createStore } = await import('@tobilu/qmd')
      const strategy = new QmdSearchStrategy({ pattern: '**/*.txt' })

      await strategy.search(mockStorage, 'test query')

      expect(createStore).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { collections: { storage: { path: '/tmp/test-storage', pattern: '**/*.txt' } } },
        })
      )
    })

    it('uses custom dbPath', async () => {
      const { createStore } = await import('@tobilu/qmd')
      const strategy = new QmdSearchStrategy({ dbPath: '/custom/index.sqlite' })

      await strategy.search(mockStorage, 'test query')

      expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ dbPath: '/custom/index.sqlite' }))
    })

    it('returns empty array when no matches', async () => {
      const strategy = new QmdSearchStrategy()

      const results = await strategy.search(mockStorage, 'nonexistent')

      expect(results).toEqual([])
    })

    it('strips stop words from queries', async () => {
      const strategy = new QmdSearchStrategy()

      await strategy.search(mockStorage, 'What did the charity race raise awareness for?')

      const allFn = mockPrepare.mock.results[0]!.value.all
      expect(allFn).toHaveBeenCalledWith('"charity"* OR "race"* OR "raise"* OR "awareness"*', 30, 10)
    })

    it('returns empty when query is only stop words', async () => {
      const strategy = new QmdSearchStrategy()

      const results = await strategy.search(mockStorage, 'what is the')

      expect(results).toEqual([])
      expect(mockPrepare).not.toHaveBeenCalled()
    })

    it('throws when storage has no baseDir', async () => {
      const strategy = new QmdSearchStrategy()
      const storageWithoutPath = { write: vi.fn(), read: vi.fn(), delete: vi.fn(), list: vi.fn() }

      await expect(strategy.search(storageWithoutPath, 'test')).rejects.toThrow(
        'QmdSearchStrategy requires a FileSystemStorage'
      )
    })
  })

  describe('update', () => {
    it('re-indexes without searching', async () => {
      const strategy = new QmdSearchStrategy()

      await strategy.update(mockStorage)

      expect(mockQmdStore.update).toHaveBeenCalled()
      expect(mockPrepare).not.toHaveBeenCalled()
    })
  })

  describe('close', () => {
    it('closes the QMD store', async () => {
      const strategy = new QmdSearchStrategy()
      await strategy.search(mockStorage, 'init query')

      await strategy.close()

      expect(mockQmdStore.close).toHaveBeenCalled()
    })

    it('is safe to call without initialization', async () => {
      const strategy = new QmdSearchStrategy()

      await strategy.close()

      expect(mockQmdStore.close).not.toHaveBeenCalled()
    })
  })
})
