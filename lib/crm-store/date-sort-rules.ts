/**
 * "Sort by date" on a storage folder (dev job 1f4645b6, 2026-11-04) — the PURE part: read the date out of a name, build the year / month folder
 * names the person chose, plan which item goes where, and order the year / month folders newest- or oldest-first. No database, no React: the
 * same rules run in the preview, in the move, and in the folder list (so the web page and Finder show one order).
 */

export type Grouping = "year" | "year_month" | "month"
export type MonthLabel = "number" | "number_name" | "name"
export type SortOrder = "newest" | "oldest"

export interface DateSortSettings {
  grouping: Grouping
  monthLabel: MonthLabel
  order: SortOrder
  /** Optional own patterns that replace the built-in names. Tokens: {year} {month} (01–12) {monthName} (January…). */
  custom?: { year?: string; month?: string }
}

/** The default Antonio chose: year, then "11 November", newest first. */
export const DEFAULT_DATE_SORT: DateSortSettings = { grouping: "year_month", monthLabel: "number_name", order: "newest" }

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const

const GROUPINGS: Grouping[] = ["year", "year_month", "month"]
const LABELS: MonthLabel[] = ["number", "number_name", "name"]
const ORDERS: SortOrder[] = ["newest", "oldest"]
const PATTERN_TOKENS = /\{(year|month|monthName)\}/g

/** Validate whatever came from a request or the database; null = not usable (the caller says why in plain words). */
export function parseSettings(v: unknown): { ok: true; settings: DateSortSettings } | { ok: false; message: string } {
  if (!v || typeof v !== "object") return { ok: false, message: "Choose how to group." }
  const o = v as Record<string, unknown>
  if (!GROUPINGS.includes(o.grouping as Grouping)) return { ok: false, message: "Choose how to group: year only, year then month, or month only." }
  if (!LABELS.includes(o.monthLabel as MonthLabel)) return { ok: false, message: "Choose how the month is written." }
  if (!ORDERS.includes(o.order as SortOrder)) return { ok: false, message: "Choose newest first or oldest first." }
  const settings: DateSortSettings = { grouping: o.grouping as Grouping, monthLabel: o.monthLabel as MonthLabel, order: o.order as SortOrder }
  const c = o.custom
  if (c && typeof c === "object") {
    const cc = c as Record<string, unknown>
    const custom: { year?: string; month?: string } = {}
    for (const k of ["year", "month"] as const) {
      const raw = cc[k]
      if (raw === undefined || raw === null || raw === "") continue
      if (typeof raw !== "string" || raw.length > 60) return { ok: false, message: "A custom pattern is too long (60 characters at most)." }
      if (/[/\\]/.test(raw)) return { ok: false, message: "A folder name can't contain a slash." }
      const left = raw.replace(PATTERN_TOKENS, "").trim()
      if (/[{}]/.test(left)) return { ok: false, message: "Use only {year}, {month} and {monthName} inside braces." }
      if (!PATTERN_TOKENS.test(raw)) { PATTERN_TOKENS.lastIndex = 0; return { ok: false, message: `The ${k} pattern must contain {year}, {month} or {monthName}, or every date would land in one folder.` } }
      PATTERN_TOKENS.lastIndex = 0
      custom[k] = raw.trim()
    }
    if (custom.year || custom.month) settings.custom = custom
  }
  return { ok: true, settings }
}

export interface DatedParts { year: number; month: number; day: number }

/** The date at the START of a name ("2026-11-02 06.59.32 …"), or null. A real calendar day, year 2000–2100. */
export function dateFromName(name: string): DatedParts | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(name)
  if (!m) return null
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return null
  const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day > daysIn ? null : { year, month, day }
}

const pad2 = (n: number) => String(n).padStart(2, "0")
const fill = (pattern: string, d: { year: number; month: number }) =>
  pattern.replace(/\{year\}/g, String(d.year)).replace(/\{month\}/g, pad2(d.month)).replace(/\{monthName\}/g, MONTH_NAMES[d.month - 1])

export function monthLabelFor(month: number, label: MonthLabel): string {
  return label === "number" ? pad2(month) : label === "number_name" ? `${pad2(month)} ${MONTH_NAMES[month - 1]}` : MONTH_NAMES[month - 1]
}

/** The folder names an item with this date goes into, outermost first (one name for "year" and "month", two for "year then month"). */
export function groupPath(d: { year: number; month: number }, s: DateSortSettings): string[] {
  const yearName = s.custom?.year ? fill(s.custom.year, d) : String(d.year)
  if (s.grouping === "year") return [yearName]
  if (s.grouping === "year_month") return [yearName, s.custom?.month ? fill(s.custom.month, d) : monthLabelFor(d.month, s.monthLabel)]
  // month only: the year has to be in the name, or every June would land together
  if (s.custom?.month) return [fill(s.custom.month, d)]
  return [s.monthLabel === "name" ? `${MONTH_NAMES[d.month - 1]} ${d.year}` : s.monthLabel === "number" ? `${d.year}-${pad2(d.month)}` : `${d.year}-${pad2(d.month)} ${MONTH_NAMES[d.month - 1]}`]
}

export interface PlanItem { id: string; kind: "file" | "folder"; name: string; locked?: string | null }
export interface PlannedMove { id: string; kind: "file" | "folder"; name: string; path: string[]; date: string }
export interface SortPlan {
  moves: PlannedMove[]
  /** Items left where they are, with the reason in plain words (no date in the name, a fixed folder). */
  stay: Array<{ id: string; name: string; reason: string }>
  /** Group folders that will be created (path joined with " / "). */
  newGroups: string[]
  /** Group folder names the move would reuse. */
  reusedGroups: string[]
  /** Items whose target already holds something with the same name — they are not moved. */
  clashes: Array<{ id: string; name: string; reason: string }>
}

/** The lower-case key of a group folder path, e.g. ["2026","11 November"] -> "2026/11 november". */
export const groupKey = (path: string[]): string => path.map((p) => p.trim().toLowerCase()).join("/")

/**
 * PURE: which of a folder's items go where. `held` = for every group folder that ALREADY exists (an earlier run made it), what it holds, keyed by
 * `groupKey` — so a group is reused, not duplicated, and a same-name item is a clash, not an overwrite. A key missing from `held` means "not there yet".
 */
export function planSort(items: PlanItem[], s: DateSortSettings, held: Map<string, Set<string>> = new Map()): SortPlan {
  const lc = (x: string) => x.trim().toLowerCase()
  const moves: PlannedMove[] = []
  const stay: SortPlan["stay"] = []
  const clashes: SortPlan["clashes"] = []
  const created = new Set<string>(), reused = new Set<string>()
  const planned = new Map<string, Set<string>>()          // names already planned into a group, so two items with one name don't both go in
  for (const it of items) {
    const d = dateFromName(it.name)
    if (!d) { stay.push({ id: it.id, name: it.name, reason: "no date at the start of the name" }); continue }
    if (it.locked) { stay.push({ id: it.id, name: it.name, reason: it.locked }); continue }
    const path = groupPath(d, s)
    const key = groupKey(path)
    const before = held.get(key)
    const now = planned.get(key) ?? new Set<string>()
    if (before?.has(lc(it.name)) || now.has(lc(it.name))) { clashes.push({ id: it.id, name: it.name, reason: `"${path.join(" / ")}" already has "${it.name}"` }); continue }
    now.add(lc(it.name)); planned.set(key, now)
    for (let depth = 1; depth <= path.length; depth++) {
      const label = path.slice(0, depth).join(" / ")
      if (held.has(groupKey(path.slice(0, depth)))) reused.add(label); else created.add(label)
    }
    moves.push({ id: it.id, kind: it.kind, name: it.name, path, date: `${d.year}-${pad2(d.month)}-${pad2(d.day)}` })
  }
  return { moves, stay, newGroups: Array.from(created), reusedGroups: Array.from(reused), clashes }
}

/** A year / month key out of a group folder's NAME, so the folders can be listed newest- or oldest-first. null = not a date group. */
export function groupKeyFromName(name: string): number | null {
  const n = name.trim()
  const ym = /(?:^|\D)((?:19|20)\d{2})(?!\d)/.exec(n)
  const year = ym ? Number(ym[1]) : null
  const rest = ym ? (n.slice(0, ym.index) + " " + n.slice(ym.index + ym[0].length)).trim() : n
  let month: number | null = null
  const nameHit = MONTH_NAMES.findIndex((mn) => new RegExp(`(?:^|[^a-z])${mn}(?![a-z])`, "i").test(rest))
  if (nameHit >= 0) month = nameHit + 1
  else { const num = /(?:^|\D)(0?[1-9]|1[0-2])(?!\d)/.exec(rest); if (num) month = Number(num[1]) }
  if (year === null && month === null) return null
  if (year === null) return month!                       // month folders inside a year: 1–12
  return year * 100 + (month ?? 0)
}

/**
 * The order the sub-folders of a "sorted" folder are listed in. Date groups first by the chosen order; anything that is not a date group keeps its
 * name order and stays ABOVE them (so a hand-made "Notes" folder is not buried under 2026).
 */
export function orderFolders<T extends { name: string }>(list: T[], order: SortOrder): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name)
  const groups: Array<{ f: T; k: number }> = []
  const others: T[] = []
  for (const f of list) { const k = groupKeyFromName(f.name); if (k === null) others.push(f); else groups.push({ f, k }) }
  groups.sort((a, b) => (order === "newest" ? b.k - a.k : a.k - b.k) || byName(a.f, b.f))
  return [...others.sort(byName), ...groups.map((g) => g.f)]
}
