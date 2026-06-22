import { describe, it, expect } from 'vitest'
import { detectContentType, grepOutline, treeOutline, tableOutline } from '../outline.js'

describe('detectContentType', () => {
  it('detects JSON objects and arrays', () => {
    expect(detectContentType('{"a": 1, "b": [2, 3]}')).toBe('json')
    expect(detectContentType('[{"x": 1}]')).toBe('json')
  })

  it('does not call a bare number or word JSON', () => {
    expect(detectContentType('42')).toBe('unstructured')
    expect(detectContentType('hello world')).toBe('unstructured')
  })

  it('detects grep output by file:line: prefixes', () => {
    const grep = [
      'src/app.ts:10: const x = 1',
      'src/app.ts:42: return x',
      'lib/util.ts:7: export function f() {}',
    ].join('\n')
    expect(detectContentType(grep)).toBe('grep')
  })

  it('detects directory listings (ls -l and bare paths)', () => {
    const lsLong = [
      '-rw-r--r--  1 user group 1024 Jan 1 12:00 README.md',
      'drwxr-xr-x  2 user group 4096 Jan 1 12:00 src',
    ].join('\n')
    expect(detectContentType(lsLong)).toBe('tree')
    const paths = ['src/app.ts', 'src/lib/util.ts', 'test/app.test.ts'].join('\n')
    expect(detectContentType(paths)).toBe('tree')
  })

  it('detects tabular data with a consistent delimiter', () => {
    const csv = ['id,name,active', '1,alice,true', '2,bob,false'].join('\n')
    expect(detectContentType(csv)).toBe('table')
  })

  it('detects code by file-extension hint', () => {
    expect(detectContentType('some content\nmore content', 'src/widget.py')).toBe('code')
  })

  it('detects code by token density', () => {
    const code = ['function foo() {', '  const x = 1', '  return x', '}'].join('\n')
    expect(detectContentType(code)).toBe('code')
  })

  it('falls back to unstructured for free-form prose', () => {
    const prose = 'The quick brown fox jumped over the lazy dog. It was a fine day for jumping around.'
    expect(detectContentType(prose)).toBe('unstructured')
  })

  it('does not misclassify JSON embedded in a log line', () => {
    const log = '2026-01-01 INFO request handled {"status": 200}\n2026-01-01 INFO done'
    // Leading text is not `[`/`{`, so JSON parse is not attempted → not 'json'.
    expect(detectContentType(log)).not.toBe('json')
  })
})

describe('grepOutline', () => {
  it('keeps file:line locations and drops matched content', () => {
    const grep = [
      'src/app.ts:10:        const secret = computeThing()',
      'src/app.ts:42:        return secret',
      'lib/util.ts:7:        export function helper() {}',
    ].join('\n')
    const out = grepOutline(grep)
    expect(out).toContain('src/app.ts:10')
    expect(out).toContain('lib/util.ts:7')
    expect(out).not.toContain('computeThing')
    expect(out).toContain('3 matches across 2 file(s)')
  })

  it('caps the match list and reports how many were elided', () => {
    const many = Array.from({ length: 150 }, (_, i) => `f.ts:${i}: line ${i}`).join('\n')
    const out = grepOutline(many, 50)
    expect(out).toContain('more]')
    expect(out.split('\n').length).toBeLessThan(60)
  })
})

describe('treeOutline', () => {
  it('strips ls -l metadata, keeping names', () => {
    const lsLong = [
      '-rw-r--r--  1 user group 1024 Jan 1 12:00 README.md',
      'drwxr-xr-x  2 user group 4096 Jan 1 12:00 src',
    ].join('\n')
    const out = treeOutline(lsLong)
    expect(out).toContain('README.md')
    expect(out).toContain('src')
    expect(out).not.toContain('1024')
    expect(out).toContain('2 entries')
  })

  it('keeps bare paths as-is', () => {
    const paths = ['src/app.ts', 'src/lib/util.ts'].join('\n')
    const out = treeOutline(paths)
    expect(out).toContain('src/app.ts')
    expect(out).toContain('src/lib/util.ts')
  })
})

describe('tableOutline', () => {
  it('keeps header + inferred column types + row count, drops rows', () => {
    const csv = ['id,name,active,score', '1,alice,true,9.5', '2,bob,false,3.0'].join('\n')
    const out = tableOutline(csv)
    expect(out).toContain('2 rows × 4 cols')
    expect(out).toContain('id: int')
    expect(out).toContain('name: string')
    expect(out).toContain('active: bool')
    expect(out).toContain('score: float')
    expect(out).not.toContain('alice')
  })

  it('returns input unchanged when not delimited', () => {
    const text = 'just a sentence with no delimiter structure at all'
    expect(tableOutline(text)).toBe(text)
  })
})
