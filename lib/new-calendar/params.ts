/**
 * New Calendar — the page state lives in the web address (dev job 40235e3c). PURE and client-safe.
 *
 * Everything a visitor can type is treated as hostile: repeated parameters collapse to the first value, text is
 * length-capped and only ever compared in memory (never put into a database filter or a regular expression), unknown
 * list names fall back to the default, and the row limit is clamped. No decodeURIComponent: Next has already decoded once.
 */

import { WAIT_SLUG_RE } from "@/lib/open-services/types"
import { LISTS, MAX_LIMIT, MAX_TEXT_LENGTH, PAGE_SIZE, type ListKey } from "@/lib/new-calendar/types"

export type RawSearchParams = Record<string, string | string[] | undefined>

/** Which page of the New Calendar: the open jobs, the What's New feed, or the payments waiting for confirmation. */
export const TABS = ["jobs", "news", "payments"] as const
export type CalendarTab = (typeof TABS)[number]

export interface NewCalendarParams {
  /** "jobs" (default) or "news" = the What's New tab. Every other parameter belongs to "jobs". */
  tab: CalendarTab
  /** Which list: all open (the default) / to work on / pending / not sorted yet / closed. */
  b: ListKey
  /** A service chosen on the chips ("" = all services). Free text: it is whatever the service is called. */
  s: string
  /** A step of that service ("" = none). Only meaningful together with `s`. */
  st: string
  /** The "Waiting on" chip chosen on the Pending list: a kind slug or "paused" ("" = all). Only slug-shaped text is kept here; the builder checks it against the real kinds. */
  w: string
  /** Search text for a company or person name. */
  q: string
  /** How many rows to show (PAGE_SIZE, then more on "Show more"). */
  n: number
}

/** The first screen shows EVERY open job (Antonio 2026-10-16), so a job never "disappears" the moment its next step belongs to someone else. */
export const DEFAULT_BUCKET: ListKey = "all"

function first(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === "string" ? s : ""
}

/** Folds typographic apostrophes, collapses whitespace, trims, caps the length. */
export function cleanText(raw: string): string {
  return raw
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
}

/**
 * Two names are "the same" the way the web address sees them: after the same cleaning the address gets (curly apostrophes, doubled
 * spaces, trimming, the length cap). A chip carries the name as the data has it; the address comes back cleaned; both sides of every
 * comparison go through this so a name with such characters can never give an empty list under a chip that shows a count.
 */
export function sameText(a: string, b: string): boolean {
  return cleanText(a) === cleanText(b)
}

export function sameTextLoose(a: string, b: string): boolean {
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase()
}

export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return PAGE_SIZE
  return Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, Math.trunc(n)))
}

export function parseParams(raw: RawSearchParams): NewCalendarParams {
  const tabRaw = first(raw.tab).trim().toLowerCase()
  const tab: CalendarTab = tabRaw === "news" ? "news" : tabRaw === "payments" ? "payments" : "jobs"
  const bRaw = first(raw.b).trim().toLowerCase()
  const b: ListKey = (LISTS as readonly string[]).includes(bRaw) ? (bRaw as ListKey) : DEFAULT_BUCKET
  const s = cleanText(first(raw.s))
  // A step means nothing without its service.
  const st = s === "" ? "" : cleanText(first(raw.st))
  const wRaw = cleanText(first(raw.w)).toLowerCase()
  const w = b === "pending" && WAIT_SLUG_RE.test(wRaw) ? wRaw : ""
  const q = cleanText(first(raw.q))
  const n = clampLimit(Number.parseInt(first(raw.n), 10))
  return { tab, b, s, st, w, q, n }
}

/** The web address query for these params ("" when everything is default). */
export function toQueryString(p: NewCalendarParams): string {
  // The What's New tab has no filters of its own.
  if (p.tab === "news") return "?tab=news"
  // So does the payments tab.
  if (p.tab === "payments") return "?tab=payments"
  const sp = new URLSearchParams()
  if (p.b !== DEFAULT_BUCKET) sp.set("b", p.b)
  if (p.s) sp.set("s", p.s)
  if (p.s && p.st) sp.set("st", p.st)
  if (p.b === "pending" && p.w) sp.set("w", p.w)
  if (p.q) sp.set("q", p.q)
  if (p.n !== PAGE_SIZE) sp.set("n", String(p.n))
  const out = sp.toString()
  return out ? `?${out}` : ""
}

/** Switching tab keeps nothing from the other one. */
export function withTab(p: NewCalendarParams, tab: CalendarTab): NewCalendarParams {
  return { ...p, tab, b: DEFAULT_BUCKET, s: "", st: "", w: "", q: "", n: PAGE_SIZE }
}

/** Choosing a list clears the service, the step and the paging, and keeps the search. */
export function withBucket(p: NewCalendarParams, b: ListKey): NewCalendarParams {
  return { ...p, b, s: "", st: "", w: "", n: PAGE_SIZE }
}

/** Choosing a service ("" = all services) clears the step and the paging. */
export function withService(p: NewCalendarParams, s: string): NewCalendarParams {
  return { ...p, s, st: "", n: PAGE_SIZE }
}

/** Choosing a "Waiting on" chip ("" = all; the chip already chosen clears itself) keeps the service and the search, and starts the paging over. */
export function withWait(p: NewCalendarParams, w: string): NewCalendarParams {
  return { ...p, w: p.w === w ? "" : w, n: PAGE_SIZE }
}

/** Choosing the step that is already chosen clears it. */
export function withStep(p: NewCalendarParams, st: string): NewCalendarParams {
  return { ...p, st: p.st === st ? "" : st, n: PAGE_SIZE }
}

export function withMore(p: NewCalendarParams): NewCalendarParams {
  return { ...p, n: clampLimit(p.n + PAGE_SIZE) }
}
