import { describe, it, expect } from 'vitest'
import { importancePreview, queryTerms } from '../importance.js'
import { previewText } from '../content.js'

describe('queryTerms', () => {
  it('extracts lowercased word tokens of length >= 3', () => {
    const terms = queryTerms('Fix the FooBar parser in axes3d.py')
    expect(terms.has('foobar')).toBe(true)
    expect(terms.has('axes3d')).toBe(true)
    expect(terms.has('the')).toBe(true)
    expect(terms.has('in')).toBe(false) // length < 3
  })

  it('returns empty set for undefined', () => {
    expect(queryTerms(undefined).size).toBe(0)
  })
})

describe('importancePreview', () => {
  const filler = Array.from({ length: 200 }, (_, i) => `filler log line number ${i} nothing useful here`).join('\n')

  it('returns the whole text when it already fits the budget', () => {
    expect(importancePreview('short', 100)).toBe('short')
  })

  it('keeps error lines even when buried in the middle of large output', () => {
    const text = [filler, 'ERROR: NullPointerException at line 42', filler].join('\n')
    const preview = importancePreview(text, 60)
    expect(preview).toContain('ERROR: NullPointerException at line 42')
    expect(preview.length).toBeLessThan(text.length)
    expect(preview).toContain('elided')
  })

  it('keeps query-relevant lines that head/tail would discard', () => {
    const needle = 'def compute_widget_layout(self, renderer):'
    const text = [filler, needle, filler].join('\n')
    const query = 'fix the widget layout computation'
    const preview = importancePreview(text, 60, query)
    expect(preview).toContain(needle)
  })

  it('without a query, a buried plain line is dropped (shows head/tail blindness it fixes)', () => {
    const needle = 'xyzzy_unique_marker_plain_line'
    const text = [filler, needle, filler].join('\n')
    // No query and no error signal → the buried line is not prioritized.
    const preview = importancePreview(text, 40)
    expect(preview).not.toContain(needle)
    // ...but with a matching query it survives.
    expect(importancePreview(text, 40, 'locate xyzzy_unique_marker_plain_line')).toContain(needle)
  })

  it('respects the token budget (output materially smaller than input)', () => {
    const text = [filler, 'ERROR boom', filler].join('\n')
    const preview = importancePreview(text, 50)
    expect(preview.length).toBeLessThanOrEqual(text.length)
    // 50 tokens ~ 200 chars + elision markers; allow generous slack.
    expect(preview.length).toBeLessThan(text.length / 2)
  })
})

describe('previewText importance mode', () => {
  it('routes mode="importance" through the importance scorer with the query', () => {
    const filler = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const needle = 'target_symbol_here'
    const text = [filler, needle, filler].join('\n')
    const out = previewText(text, 'importance', 40, 'find target_symbol_here')
    expect(out).toContain(needle)
  })

  it('head mode still works (no regression)', () => {
    const text = 'A'.repeat(1000)
    const out = previewText(text, 'head', 10)
    expect(out.length).toBeLessThan(1000)
    expect(out.startsWith('A')).toBe(true)
  })
})
