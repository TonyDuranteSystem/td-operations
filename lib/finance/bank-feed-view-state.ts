/**
 * Where a person is in the Bank Feed list — which filter tab, which page, what they searched — kept in
 * the page address so a browser refresh (or sending the link) lands them in the same place instead of
 * back on "All", page 1 (Antonio, 2026-10-30: "when I refresh the page go back to bank feed instead of
 * staying where I was").
 *
 * Pure: parse and write only; the component decides when. Defaults are never written, so an untouched
 * list keeps a clean address. Other parameters in the address (`tab`, `feed`, …) are left alone.
 */

export const FEED_FILTERS = ["all", "unmatched", "needs_review", "activation_crashed", "matched", "ignored", "duplicate"] as const
export type FeedFilter = (typeof FEED_FILTERS)[number]

export interface FeedViewState {
  filter: FeedFilter
  /** Zero-based page index. */
  page: number
  search: string
  /** Source filter (e.g. ["stripe"]), or null for every source. */
  sources: string[] | null
}

export const DEFAULT_FEED_VIEW: FeedViewState = { filter: "all", page: 0, search: "", sources: null }

const KEYS = { filter: "bf", page: "bp", search: "bq", sources: "bs" } as const
const MAX_SEARCH = 100
const MAX_PAGE = 10_000
const SOURCE_RE = /^[a-z0-9_]{1,40}$/

/** Read the view from an address. Anything unrecognised falls back to the default for that part. */
export function parseFeedView(params: { get(name: string): string | null }): FeedViewState {
  const f = params.get(KEYS.filter)
  const filter = (FEED_FILTERS as readonly string[]).includes(f ?? "") ? (f as FeedFilter) : DEFAULT_FEED_VIEW.filter

  // The address carries the page as a person counts it (1 = first); the list uses a zero-based index.
  const rawPage = Number.parseInt(params.get(KEYS.page) ?? "", 10)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) - 1 : 0

  const search = (params.get(KEYS.search) ?? "").slice(0, MAX_SEARCH)

  const parts = (params.get(KEYS.sources) ?? "").split(",").map((s) => s.trim()).filter((s) => SOURCE_RE.test(s))
  const sources = parts.length > 0 ? parts : null

  return { filter, page, search, sources }
}

/**
 * The query string (without `?`) for an address that already has `currentQuery`, with the view's parts
 * set — or removed when they are the default. Every other parameter is kept as it was.
 */
export function writeFeedView(currentQuery: string, view: FeedViewState): string {
  const next = new URLSearchParams(currentQuery)
  const set = (key: string, value: string | null) => {
    if (value === null || value === "") next.delete(key)
    else next.set(key, value)
  }
  set(KEYS.filter, view.filter === DEFAULT_FEED_VIEW.filter ? null : view.filter)
  set(KEYS.page, view.page > 0 ? String(view.page + 1) : null)
  set(KEYS.search, view.search.trim() ? view.search.slice(0, MAX_SEARCH) : null)
  set(KEYS.sources, view.sources && view.sources.length > 0 ? view.sources.join(",") : null)
  return next.toString()
}
