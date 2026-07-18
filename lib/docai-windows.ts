/**
 * Page-window arithmetic + the read-coverage contract for scanned-document reads.
 *
 * WHY THIS FILE EXISTS
 * Google Document AI's synchronous endpoint refuses a document over
 * DOCAI_SYNC_PAGE_LIMIT pages, so a long scan (e.g. a 35-page filed tax return)
 * cannot be OCR'd in one call. The fix is to OCR a WINDOW of pages at a time.
 *
 * That introduces a hazard worse than the original bug: a partial read that
 * presents as a complete one. The council found that our absence guard
 * (`lib/ai-agent/answer-guards.ts`) treats any non-failed lookup as proof the
 * assistant "looked" — so a successful pages-1-15 read of a 35-page return would
 * license the sentence "there is no Schedule C in this return" when Schedule C
 * is on page 22. Today's wholesale failure is correctly counted as "did not
 * look"; windowing would silently remove that protection.
 *
 * So coverage is DATA, not prose. `buildCoverage` emits the pages actually
 * returned, whether the read is complete, and the exact ranges not read.
 * `looksLikeIncompleteRead` (answer-guards) keys off that data to keep an
 * incomplete read from counting as a completed search. Prose alone has already
 * failed repeatedly in this codebase — see the header of answer-guards.ts.
 *
 * Everything here is PURE: no network, no DB, no filesystem. That is deliberate
 * — the arithmetic below is where off-by-one errors would silently return the
 * WRONG page's text while reporting success, so it must be exhaustively
 * unit-testable without mocking anything.
 */

/**
 * Max pages Google Document AI accepts in ONE synchronous :process call
 * (non-imageless mode). 30 is available only to allowlisted projects; ours is
 * not, so 15 is the operative limit.
 *
 * NOTE: `lib/bank-statement-ai-extract.ts` carries a comment claiming the sync
 * cap is 30. That comment is about a path which deliberately does NOT use
 * Document AI, and 15 is the safe value under either reading — but the two
 * should not be reconciled by guesswork. Verified against Google's error text:
 * "Document pages in non-imageless mode exceed the limit: 15 got N."
 */
export const DOCAI_SYNC_PAGE_LIMIT = 15

/**
 * Separator the document-processing pipeline writes between pages when it saves
 * extracted text. Because the stored text is page-delimited, a page or range
 * request can be served straight from storage — no download, no OCR call, no
 * per-page billing, and no page limit.
 *
 * Single source of truth: the writer imports this too. If the two ever diverge,
 * stored text silently stops being page-addressable and every stored read
 * collapses to one giant "page 1".
 */
export const STORED_PAGE_DELIMITER = "\n---PAGE BREAK---\n"

/** An inclusive, 1-based page range. */
export type PageRange = [start: number, end: number]

export interface PageSelection {
  /** Inclusive 1-based window to OCR. */
  window: PageRange
  /** True when the caller asked for more pages than one window can carry. */
  clamped: boolean
  /** What the caller actually asked for, normalized (null = "no preference"). */
  requested: PageRange | null
}

/** True for a positive whole number. Rejects NaN, Infinity, 0, negatives, fractions. */
function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n > 0
}

/**
 * Parse a `pages` selector into an inclusive 1-based range.
 * Accepts "12", "12-18", " 12 - 18 ", and normalizes a reversed range ("18-12").
 * Returns null for anything it cannot read as a range — the caller decides
 * whether that is an error or a "no preference"; this function never guesses.
 */
export function parsePageRange(input: unknown): PageRange | null {
  if (typeof input === "number") return isPositiveInt(input) ? [input, input] : null
  if (typeof input !== "string") return null
  const s = input.trim()
  if (!s) return null

  const single = /^(\d+)$/.exec(s)
  if (single) {
    const n = Number(single[1])
    return isPositiveInt(n) ? [n, n] : null
  }

  const pair = /^(\d+)\s*-\s*(\d+)$/.exec(s)
  if (!pair) return null
  let a = Number(pair[1])
  let b = Number(pair[2])
  if (!isPositiveInt(a) || !isPositiveInt(b)) return null
  if (a > b) [a, b] = [b, a] // "18-12" means the same as "12-18"
  return [a, b]
}

/**
 * Choose the window to OCR.
 *
 * `requested` null → the first window (pages 1..limit). Callers that want a
 * different default (e.g. head+tail for tax returns) must pass a range; this
 * function does not invent one.
 *
 * The window is clamped to the document and to `limit` pages. `clamped` is true
 * when the caller asked for more than the window can carry — the caller MUST
 * surface that, because a silent clamp is exactly the partial-read-as-complete
 * failure this module exists to prevent.
 */
export function selectWindow(
  requested: PageRange | null,
  documentPageCount: number,
  limit: number = DOCAI_SYNC_PAGE_LIMIT,
): PageSelection {
  const total = isPositiveInt(documentPageCount) ? documentPageCount : 0
  const cap = isPositiveInt(limit) ? limit : DOCAI_SYNC_PAGE_LIMIT

  if (total === 0) return { window: [1, 0], clamped: false, requested }

  if (!requested) {
    const end = Math.min(cap, total)
    return { window: [1, end], clamped: total > cap, requested: null }
  }

  // A start past the end of the document is not satisfiable — report it as an
  // empty window rather than silently returning some other page's text.
  if (requested[0] > total) {
    return { window: [requested[0], requested[0] - 1], clamped: false, requested }
  }

  const start = requested[0]
  const wantedEnd = Math.min(requested[1], total)
  const end = Math.min(wantedEnd, start + cap - 1)
  return { window: [start, end], clamped: end < wantedEnd, requested }
}

/** Number of pages in an inclusive range; 0 when the range is empty. */
export function rangeSize(range: PageRange): number {
  return Math.max(0, range[1] - range[0] + 1)
}

/** True when the window contains no pages (start past end). */
export function isEmptyWindow(range: PageRange): boolean {
  return rangeSize(range) === 0
}

/**
 * Translate an ABSOLUTE 1-based page number into an index within a window's
 * page array. Returns null when the page is outside the window.
 *
 * This is the single most dangerous piece of arithmetic in the feature: indexing
 * a window's array with an absolute page number returns the wrong page's text
 * and reports success. Three independent reviewers found that defect in the
 * draft design, so it lives here, alone, and is tested at both window edges.
 */
export function absolutePageToWindowIndex(page: number, window: PageRange): number | null {
  if (!isPositiveInt(page) || isEmptyWindow(window)) return null
  if (page < window[0] || page > window[1]) return null
  return page - window[0]
}

export interface ReadCoverage {
  /** TRUE page count of the document, from the local split — never the OCR'd count. */
  document_page_count: number
  /** Inclusive 1-based range actually present in the returned text. */
  pages_returned: PageRange
  /** False whenever `pages_returned` does not cover the whole document. */
  complete: boolean
  /** Ranges NOT read, so the reader can ask for them by number. */
  pages_not_read: PageRange[]
}

/**
 * Build the machine-readable coverage record.
 *
 * `pagesReturned` MUST reflect the text after any character truncation, not the
 * range that was requested — a reader reasoning "I read through page 15" from a
 * response whose text stopped inside page 3 is reasoning about pages it never
 * received.
 *
 * Field names deliberately avoid anything matching /error/ — the absence guard
 * scans a result's first 600 characters for error-shaped keys, so an
 * `error`-named field on a SUCCESSFUL partial read would misclassify it as a
 * failed lookup and disarm a different guard.
 */
export function buildCoverage(documentPageCount: number, pagesReturned: PageRange): ReadCoverage {
  const total = isPositiveInt(documentPageCount) ? documentPageCount : 0

  if (total === 0 || isEmptyWindow(pagesReturned)) {
    return {
      document_page_count: total,
      pages_returned: [1, 0],
      complete: false,
      pages_not_read: total > 0 ? [[1, total]] : [],
    }
  }

  const start = Math.max(1, pagesReturned[0])
  const end = Math.min(total, pagesReturned[1])
  const notRead: PageRange[] = []
  if (start > 1) notRead.push([1, start - 1])
  if (end < total) notRead.push([end + 1, total])

  return {
    document_page_count: total,
    pages_returned: [start, end],
    complete: notRead.length === 0,
    pages_not_read: notRead,
  }
}

/**
 * Human-readable companion to the structured coverage. The DATA is the
 * guarantee; this sentence only helps the reader act on it.
 */
export function coverageNote(coverage: ReadCoverage): string {
  if (coverage.document_page_count === 0) {
    return "The page count of this document could not be determined."
  }
  if (coverage.complete) {
    return `Read the whole document (${coverage.document_page_count} page(s)).`
  }
  const ranges = coverage.pages_not_read
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(", ")
  const [s, e] = coverage.pages_returned
  const shown = s === e ? `page ${s}` : `pages ${s}-${e}`
  return (
    `INCOMPLETE READ: this document has ${coverage.document_page_count} pages; you have only seen ${shown}. ` +
    `Pages ${ranges} have NOT been read. ` +
    "Do NOT state that something is absent from this document — you have not seen all of it. " +
    `Ask for the missing pages by number (e.g. pages "${coverage.pages_not_read[0][0]}-${coverage.pages_not_read[0][1]}") before drawing any conclusion about what the document does or does not contain.`
  )
}
