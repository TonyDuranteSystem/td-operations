/**
 * Open services tab — the page state lives in the web address (N1a C3). PURE and client-safe.
 *
 * Everything a visitor can type is treated as hostile: repeated parameters are collapsed to the first value, the search
 * text is length-capped, unknown values are dropped, and numbers are clamped. The search text is only ever compared in
 * memory — it is never put into a database filter or a regular expression. No decodeURIComponent: Next has already
 * decoded each value once.
 */

import { MAX_LIMIT, MAX_QUERY_LENGTH, PAGE_SIZE, WHO_VALUES, type View, type Who } from "@/lib/open-services/types"

export type RawSearchParams = Record<string, string | string[] | undefined>

export interface OpenServicesParams {
  view: View
  who: Who[]
  late: boolean
  q: string
  /** Per-group row limits as [groupKey, limit] pairs (array, not an object: group keys are free text). */
  more: Array<[string, number]>
}

const MAX_MORE_ENTRIES = 50

function first(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === "string" ? s : ""
}

function all(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  return (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === "string")
}

/** Folds typographic apostrophes, collapses whitespace, trims, caps the length. */
export function cleanQuery(raw: string): string {
  return raw
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
}

export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return PAGE_SIZE
  const i = Math.trunc(n)
  return Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, i))
}

export function parseParams(raw: RawSearchParams): OpenServicesParams {
  const view: View = first(raw.view) === "service" ? "service" : "who"

  const who: Who[] = []
  for (const part of first(raw.who).split(",")) {
    const v = part.trim().toLowerCase()
    if ((WHO_VALUES as readonly string[]).includes(v) && !who.includes(v as Who)) who.push(v as Who)
  }

  const late = first(raw.late) === "1"
  const q = cleanQuery(first(raw.q))

  const more: Array<[string, number]> = []
  for (const entry of all(raw.more).slice(0, MAX_MORE_ENTRIES)) {
    const s = entry.slice(0, 300)
    const idx = s.lastIndexOf("~")
    if (idx <= 0) continue
    const key = s.slice(0, idx)
    const n = Number.parseInt(s.slice(idx + 1), 10)
    if (!Number.isFinite(n)) continue
    if (!more.some(([k]) => k === key)) more.push([key, clampLimit(n)])
  }

  return { view, who, late, q, more }
}

export function limitFor(params: OpenServicesParams, groupKey: string): number {
  const hit = params.more.find(([k]) => k === groupKey)
  return hit ? hit[1] : PAGE_SIZE
}

/** The web address query for these params ("" when everything is default). */
export function toQueryString(params: OpenServicesParams): string {
  const sp = new URLSearchParams()
  if (params.view !== "who") sp.set("view", params.view)
  if (params.who.length) sp.set("who", params.who.join(","))
  if (params.late) sp.set("late", "1")
  if (params.q) sp.set("q", params.q)
  for (const [k, n] of params.more) sp.append("more", `${k}~${n}`)
  const s = sp.toString()
  return s ? `?${s}` : ""
}

/** Changing the view or a filter starts the "Show more" counters over; "Show more" itself keeps the filters. */
export function withFilterChange(params: OpenServicesParams, patch: Partial<Omit<OpenServicesParams, "more">>): OpenServicesParams {
  return { ...params, ...patch, more: [] }
}

export function withMore(params: OpenServicesParams, groupKey: string, nextLimit: number): OpenServicesParams {
  const more = params.more.filter(([k]) => k !== groupKey)
  more.push([groupKey, clampLimit(nextLimit)])
  return { ...params, more: more.slice(-MAX_MORE_ENTRIES) }
}

export function withoutMore(params: OpenServicesParams, groupKey: string): OpenServicesParams {
  return { ...params, more: params.more.filter(([k]) => k !== groupKey) }
}
