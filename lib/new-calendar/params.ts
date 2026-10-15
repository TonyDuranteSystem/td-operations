/**
 * New Calendar — the page state lives in the web address (dev job 40235e3c). PURE and client-safe.
 *
 * Everything a visitor can type is treated as hostile: repeated parameters collapse to the first value, text is
 * length-capped and only ever compared in memory (never put into a database filter or a regular expression), unknown
 * list names fall back to the default, and the row limit is clamped. No decodeURIComponent: Next has already decoded once.
 */

import { BUCKETS, MAX_LIMIT, MAX_TEXT_LENGTH, PAGE_SIZE, type Bucket } from "@/lib/new-calendar/types"

export type RawSearchParams = Record<string, string | string[] | undefined>

export interface NewCalendarParams {
  /** Which list: to work on / pending / not sorted yet / closed. */
  b: Bucket
  /** A service chosen on the chips ("" = all services). Free text: it is whatever the service is called. */
  s: string
  /** A step of that service ("" = none). Only meaningful together with `s`. */
  st: string
  /** Search text for a company or person name. */
  q: string
  /** How many rows to show (PAGE_SIZE, then more on "Show more"). */
  n: number
}

export const DEFAULT_BUCKET: Bucket = "work"

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
  const bRaw = first(raw.b).trim().toLowerCase()
  const b: Bucket = (BUCKETS as readonly string[]).includes(bRaw) ? (bRaw as Bucket) : DEFAULT_BUCKET
  const s = cleanText(first(raw.s))
  // A step means nothing without its service.
  const st = s === "" ? "" : cleanText(first(raw.st))
  const q = cleanText(first(raw.q))
  const n = clampLimit(Number.parseInt(first(raw.n), 10))
  return { b, s, st, q, n }
}

/** The web address query for these params ("" when everything is default). */
export function toQueryString(p: NewCalendarParams): string {
  const sp = new URLSearchParams()
  if (p.b !== DEFAULT_BUCKET) sp.set("b", p.b)
  if (p.s) sp.set("s", p.s)
  if (p.s && p.st) sp.set("st", p.st)
  if (p.q) sp.set("q", p.q)
  if (p.n !== PAGE_SIZE) sp.set("n", String(p.n))
  const out = sp.toString()
  return out ? `?${out}` : ""
}

/** Choosing a list clears the service, the step and the paging, and keeps the search. */
export function withBucket(p: NewCalendarParams, b: Bucket): NewCalendarParams {
  return { ...p, b, s: "", st: "", n: PAGE_SIZE }
}

/** Choosing a service ("" = all services) clears the step and the paging. */
export function withService(p: NewCalendarParams, s: string): NewCalendarParams {
  return { ...p, s, st: "", n: PAGE_SIZE }
}

/** Choosing the step that is already chosen clears it. */
export function withStep(p: NewCalendarParams, st: string): NewCalendarParams {
  return { ...p, st: p.st === st ? "" : st, n: PAGE_SIZE }
}

export function withMore(p: NewCalendarParams): NewCalendarParams {
  return { ...p, n: clampLimit(p.n + PAGE_SIZE) }
}
