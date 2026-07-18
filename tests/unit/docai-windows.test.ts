import { describe, it, expect } from 'vitest'
import {
  DOCAI_SYNC_PAGE_LIMIT,
  parsePageRange,
  selectWindow,
  rangeSize,
  isEmptyWindow,
  absolutePageToWindowIndex,
  buildCoverage,
  coverageNote,
} from '@/lib/docai-windows'

describe('parsePageRange', () => {
  it('reads a single page as a one-page range', () => {
    expect(parsePageRange('12')).toEqual([12, 12])
    expect(parsePageRange(12)).toEqual([12, 12])
  })

  it('reads a range and tolerates whitespace', () => {
    expect(parsePageRange('12-18')).toEqual([12, 18])
    expect(parsePageRange('  12 - 18  ')).toEqual([12, 18])
  })

  it('normalizes a reversed range instead of returning nothing', () => {
    expect(parsePageRange('18-12')).toEqual([12, 18])
  })

  it('rejects junk rather than guessing', () => {
    for (const bad of ['', '   ', 'abc', '12-', '-12', '1.5', '0', '-3', '1-2-3', null, undefined, {}, []]) {
      expect(parsePageRange(bad as unknown)).toBeNull()
    }
  })

  it('rejects zero, negative, fractional and non-finite numbers', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
      expect(parsePageRange(bad)).toBeNull()
    }
  })
})

describe('selectWindow', () => {
  it('defaults to the first window and reports that more remains', () => {
    const sel = selectWindow(null, 35)
    expect(sel.window).toEqual([1, 15])
    expect(sel.clamped).toBe(true)
  })

  it('a document that fits in one window is not clamped', () => {
    const sel = selectWindow(null, 15)
    expect(sel.window).toEqual([1, 15])
    expect(sel.clamped).toBe(false)
  })

  it('boundary: 15 pages fits, 16 pages does not', () => {
    expect(selectWindow(null, 15).clamped).toBe(false)
    expect(selectWindow(null, 16).clamped).toBe(true)
    expect(selectWindow(null, 16).window).toEqual([1, 15])
  })

  it('a single requested page yields a single-page window', () => {
    expect(selectWindow([20, 20], 35).window).toEqual([20, 20])
    expect(selectWindow([20, 20], 35).clamped).toBe(false)
  })

  it('clamps a range wider than the limit AND flags it (never a silent partial)', () => {
    const sel = selectWindow([1, 35], 35)
    expect(sel.window).toEqual([1, 15])
    expect(sel.clamped).toBe(true)
  })

  it('clamps the end to the document without flagging a clamp', () => {
    // Asking 30-999 on a 35-page doc: 30-35 is satisfiable in full.
    const sel = selectWindow([30, 999], 35)
    expect(sel.window).toEqual([30, 35])
    expect(sel.clamped).toBe(false)
  })

  it('a start past the end of the document yields an EMPTY window, not another page', () => {
    const sel = selectWindow([40, 45], 35)
    expect(isEmptyWindow(sel.window)).toBe(true)
  })

  it('a zero-page document yields an empty window', () => {
    expect(isEmptyWindow(selectWindow(null, 0).window)).toBe(true)
  })

  it('a one-page document yields exactly that page', () => {
    expect(selectWindow(null, 1).window).toEqual([1, 1])
    expect(selectWindow(null, 1).clamped).toBe(false)
  })

  it('honours a custom limit', () => {
    expect(selectWindow(null, 35, 10).window).toEqual([1, 10])
  })

  it('uses the documented Google limit by default', () => {
    expect(DOCAI_SYNC_PAGE_LIMIT).toBe(15)
    expect(selectWindow(null, 100).window[1]).toBe(DOCAI_SYNC_PAGE_LIMIT)
  })
})

describe('rangeSize / isEmptyWindow', () => {
  it('counts inclusive ranges', () => {
    expect(rangeSize([1, 15])).toBe(15)
    expect(rangeSize([20, 20])).toBe(1)
    expect(rangeSize([16, 30])).toBe(15)
  })
  it('treats start-past-end as empty, never negative', () => {
    expect(rangeSize([5, 4])).toBe(0)
    expect(rangeSize([40, 35])).toBe(0)
    expect(isEmptyWindow([5, 4])).toBe(true)
  })
})

describe('absolutePageToWindowIndex — the off-by-window defect', () => {
  it('maps an absolute page to its slot in a non-first window', () => {
    // The bug three reviewers found: indexing window 16-30 with page 20
    // must give slot 4, NOT slot 19 (undefined) and NOT slot 20.
    expect(absolutePageToWindowIndex(20, [16, 30])).toBe(4)
  })

  it('maps both EDGES of a window correctly', () => {
    expect(absolutePageToWindowIndex(16, [16, 30])).toBe(0)
    expect(absolutePageToWindowIndex(30, [16, 30])).toBe(14)
  })

  it('first window still behaves like a plain 1-based index', () => {
    expect(absolutePageToWindowIndex(1, [1, 15])).toBe(0)
    expect(absolutePageToWindowIndex(15, [1, 15])).toBe(14)
  })

  it('returns null OUTSIDE the window rather than a wrong slot', () => {
    expect(absolutePageToWindowIndex(15, [16, 30])).toBeNull()
    expect(absolutePageToWindowIndex(31, [16, 30])).toBeNull()
  })

  it('returns null for invalid page numbers and empty windows', () => {
    expect(absolutePageToWindowIndex(0, [1, 15])).toBeNull()
    expect(absolutePageToWindowIndex(-1, [1, 15])).toBeNull()
    expect(absolutePageToWindowIndex(1.5, [1, 15])).toBeNull()
    expect(absolutePageToWindowIndex(NaN, [1, 15])).toBeNull()
    expect(absolutePageToWindowIndex(1, [5, 4])).toBeNull()
  })
})

describe('buildCoverage', () => {
  it('a full read is complete with nothing unread', () => {
    const c = buildCoverage(10, [1, 10])
    expect(c.complete).toBe(true)
    expect(c.pages_not_read).toEqual([])
    expect(c.document_page_count).toBe(10)
  })

  it('a first-window read of a long document is INCOMPLETE and names the gap', () => {
    const c = buildCoverage(35, [1, 15])
    expect(c.complete).toBe(false)
    expect(c.pages_returned).toEqual([1, 15])
    expect(c.pages_not_read).toEqual([[16, 35]])
  })

  it('a middle window reports the gap on BOTH sides', () => {
    const c = buildCoverage(35, [16, 30])
    expect(c.complete).toBe(false)
    expect(c.pages_not_read).toEqual([[1, 15], [31, 35]])
  })

  it('a single-page read of a long document is incomplete', () => {
    const c = buildCoverage(35, [20, 20])
    expect(c.complete).toBe(false)
    expect(c.pages_not_read).toEqual([[1, 19], [21, 35]])
  })

  it('the true page count is always reported, even when little was read', () => {
    expect(buildCoverage(35, [1, 1]).document_page_count).toBe(35)
  })

  it('an empty read is incomplete and marks the whole document unread', () => {
    const c = buildCoverage(35, [1, 0])
    expect(c.complete).toBe(false)
    expect(c.pages_not_read).toEqual([[1, 35]])
  })

  it('an unknown page count never claims completeness', () => {
    const c = buildCoverage(0, [1, 5])
    expect(c.complete).toBe(false)
    expect(c.document_page_count).toBe(0)
  })

  it('emits NO error-shaped key (that would disarm the failed-lookup guard)', () => {
    const json = JSON.stringify(buildCoverage(35, [1, 15]))
    expect(/"?\berror\b"?\s*[:=]/i.test(json)).toBe(false)
    expect(/\blookup_failed"?\s*:\s*true\b/i.test(json)).toBe(false)
  })
})

describe('coverageNote', () => {
  it('an incomplete read forbids absence claims and names the missing pages', () => {
    const note = coverageNote(buildCoverage(35, [1, 15]))
    expect(note).toContain('INCOMPLETE READ')
    expect(note).toContain('35 pages')
    expect(note).toContain('pages 1-15')
    expect(note).toContain('16-35')
    expect(note).toContain('Do NOT state that something is absent')
  })

  it('a complete read says so plainly and does not warn', () => {
    const note = coverageNote(buildCoverage(8, [1, 8]))
    expect(note).toContain('Read the whole document')
    expect(note).not.toContain('INCOMPLETE')
  })

  it('an unknown page count is stated, not implied complete', () => {
    expect(coverageNote(buildCoverage(0, [1, 0]))).toContain('could not be determined')
  })
})
