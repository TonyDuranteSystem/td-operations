/**
 * Open services tab — shared shapes and labels (N1a C3).
 *
 * PURE and client-safe on purpose: the client view imports ONLY this file and params.ts, never build.ts / load.ts /
 * audience.ts (those reach the server-only database client). A source test pins that boundary.
 */

/**
 * "Who must move next" (dev job 40235e3c, Antonio 2026-10-16: the kinds are data he can edit, not a fixed list in code).
 *
 * A job's `who` is the SLUG of a wait kind, or "unset" (no setting). Kinds come from two places:
 *   - BUILT-IN, in this file: `us`, `client`, `none` (the engine's rules key off them: the done step is `none`, the portal's
 *     "action required" step must be `client`) plus "unset" (not stored: NULL / unknown / the step is missing);
 *   - the catalog `step_wait_kinds`: the "waiting on someone else" kinds (an outside office, the IRS, the bank, a date...).
 *     Each has ONE name and a behaviour set when it is created — `other` (Pending, late by follow-up days) or `date`
 *     (Pending, never late). Seeded: `outside` and `date`.
 * Behaviours drive the rules; names are free text. Colours come from the behaviour (the views hold the class maps).
 */
export const WAIT_BEHAVIOURS = ["ours", "client", "other", "date", "none"] as const
export type WaitBehaviour = (typeof WAIT_BEHAVIOURS)[number]

/** The "no setting" state. Never stored on a step; never a catalog row. */
export const UNSET = "unset"
/** A kind slug, or "unset". */
export type Who = string

/** Slugs a catalog kind may never use (they are built in, or mean "no setting"). */
export const RESERVED_WAIT_SLUGS: readonly string[] = ["us", "client", "none", UNSET]
/** The shape of any stored or typed kind slug: lower-case, starts with a letter, short. */
export const WAIT_SLUG_RE = /^[a-z][a-z0-9_]{0,40}$/
export const MAX_WHO_FILTERS = 20

export interface WaitKind {
  slug: string
  /** The name shown in the step editors and the manager. */
  name: string
  behaviour: WaitBehaviour
  builtin: boolean
  /** Retired from the catalog: still classifies the steps that already use it, is not offered for new picks. */
  retired: boolean
  /** Short label on chips and status pills. */
  chip: string
  /** Heading of the Open services group. */
  group: string
  /** The words after "Waiting on": "the client", "the IRS", "an outside office". */
  phrase: string
  /** Tooltip. */
  tip: string
}

/** "The IRS" → "the IRS", "An outside office" → "an outside office", "Banco Sella" → "Banco Sella". */
export function phraseOf(name: string): string {
  const n = name.trim()
  return /^(the|an?)\s/i.test(n) ? n.charAt(0).toLowerCase() + n.slice(1) : n
}

export function catalogWaitKind(slug: string, name: string, behaviour: "other" | "date", retired = false): WaitKind {
  const phrase = phraseOf(name)
  return { slug, name, behaviour, builtin: false, retired, chip: name, group: `Waiting on ${phrase}`, phrase, tip: `Waiting on ${phrase}` }
}

export const BUILTIN_WAIT_KINDS: Record<"us" | "client" | "none", WaitKind> = {
  us: { slug: "us", name: "Us", behaviour: "ours", builtin: true, retired: false, chip: "Us", group: "Waiting on us", phrase: "us", tip: "Our turn" },
  client: { slug: "client", name: "The client", behaviour: "client", builtin: true, retired: false, chip: "Client", group: "Waiting on the client", phrase: "the client", tip: "Waiting on the client" },
  none: { slug: "none", name: "Nobody: job is over", behaviour: "none", builtin: true, retired: false, chip: "Nobody (close it?)", group: "Nobody is waiting (close it?)", phrase: "nobody", tip: "Last step: nobody is waiting" },
}

/** What the page shows for a job with no setting. Not a kind: it has no behaviour. */
export const UNSET_LABELS = { chip: "Not set", group: "Waiting-on not set", phrase: "", tip: "Waiting-on not set" } as const

/** The catalog kinds that exist before anyone edits the list (and the fallback until the catalog is set up). */
export function defaultCatalogWaitKinds(): WaitKind[] {
  return [catalogWaitKind("outside", "An outside office", "other"), catalogWaitKind("date", "A date", "date")]
}

/** Order everywhere: us, the client, the catalog kinds (someone else before a date, then by name), nobody. */
export function assembleWaitKinds(catalog: readonly WaitKind[]): WaitKind[] {
  const rank = (k: WaitKind) => (k.behaviour === "other" ? 0 : 1)
  const sorted = [...catalog].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || (a.slug < b.slug ? -1 : 1))
  return [BUILTIN_WAIT_KINDS.us, BUILTIN_WAIT_KINDS.client, ...sorted, BUILTIN_WAIT_KINDS.none]
}

export function defaultWaitKinds(): WaitKind[] {
  return assembleWaitKinds(defaultCatalogWaitKinds())
}

/** The kind for a slug, or null ("unset", unknown, nothing). */
export function waitKindOf(kinds: readonly WaitKind[], slug: string | null | undefined): WaitKind | null {
  if (typeof slug !== "string") return null
  return kinds.find(k => k.slug === slug) ?? null
}

/** The first kind with this behaviour (the done step / a finished job resolves to the behaviour `none`, never to a typed slug). */
export function firstKindWith(kinds: readonly WaitKind[], behaviour: WaitBehaviour): WaitKind | null {
  return kinds.find(k => k.behaviour === behaviour) ?? null
}

/** One chip of the "waiting on" row, in display order. `behaviour` null = "unset". */
export interface WhoChip {
  who: Who
  label: string
  tip: string
  behaviour: WaitBehaviour | null
  count: number
}

export type View = "who" | "service"

export const PAGE_SIZE = 25
// Far above any real group (the whole tab is a few thousand jobs at most), so "Show more" never dead-ends on a long
// group; a group that still hits the ceiling says so (`Group.capped`) instead of offering a button that does nothing.
export const MAX_LIMIT = 5000
export const MAX_QUERY_LENGTH = 80

export type FollowUpState = "late" | "left" | "no-follow-up" | "date-step" | "no-date" | "parked"

export interface Row {
  id: string
  serviceType: string
  /** Company name, or the person's name for a job that belongs to a person. */
  name: string
  isPerson: boolean
  stage: string
  /** Position of the step in its service's step list (1-based), from the settings — never the job's own copy. */
  stepNo: number | null
  who: Who
  /** What `who` means, resolved once from the kind list (null = no setting). */
  behaviour: WaitBehaviour | null
  /** Short label (chips, pills) and the words after "Waiting on" for this job's `who`. */
  whoChip: string
  whoPhrase: string
  /** "Apr 7" / "Apr 7, 2025" (America/New_York); null when the job has no step date. */
  sinceLabel: string | null
  daysHere: number | null
  followUpDays: number | null
  /** Days past the follow-up time; set only when strictly greater than zero. */
  lateBy: number | null
  daysLeft: number | null
  followUp: FollowUpState
  /** Plain-words flags: "blocked", "on hold", "company closed", "step not in settings". */
  badges: string[]
  href: string
  /** The Calendar pop-up this job's step asks for (from the step's layout), or null: then the row links to the job page. */
  popup: CalendarPopup | null
}

/**
 * Step layout components that open as a POP-UP on the Calendar instead of sending the person to the job page (Antonio, 2026-10-15: the
 * Calendar is where the day's work is done). DATA-DRIVEN: a step has a pop-up when its layout (pipeline_stages.stage_layout) lists one of
 * these components, so no service or step name is written in code. Today: the Wrap-up of a Company Closure.
 */
export const CALENDAR_POPUPS = ["closure_wrapup"] as const
export type CalendarPopup = (typeof CALENDAR_POPUPS)[number]

/** The Calendar pop-up a step layout asks for, or null. Tolerates any shape (the layout is free-form data). */
export function popupFromLayout(layout: unknown): CalendarPopup | null {
  if (!layout || typeof layout !== "object") return null
  const components = (layout as { components?: unknown }).components
  if (!Array.isArray(components)) return null
  for (const c of components) {
    const type = c && typeof c === "object" ? (c as { type?: unknown }).type : null
    const hit = CALENDAR_POPUPS.find((p) => p === type)
    if (hit) return hit
  }
  return null
}

export interface GroupFacts {
  total: number
  noDate: number
  late: number
  notSet: number
  parked: number
}

export interface Group {
  key: string
  label: string
  rows: Row[]
  /** Jobs in the group after filters (rows may show fewer: see `limit`). */
  total: number
  limit: number
  hasMore: boolean
  /** More jobs exist but the page ceiling (MAX_LIMIT) is reached: say "narrow the search", don't offer "Show more". */
  capped: boolean
  nextLimit: number
  /** Every job in the group has its waiting-on "Not set": shown collapsed unless a filter matches inside. */
  collapsed: boolean
  /** Every job in the group (unfiltered) has its waiting-on "Not set": the group CAN be collapsed / re-collapsed. */
  collapsible: boolean
  facts: GroupFacts
}

export interface ExcludedGroup {
  label: string
  count: number
}

export interface ViewModel {
  asOf: string
  view: View
  groups: Group[]
  /** Job counts per "waiting on" kind (display order, then "Not set"), with every filter applied EXCEPT the who filter. */
  chips: WhoChip[]
  /** Late jobs, with every filter applied except the late filter. */
  lateChip: number
  shown: number
  late: number
  noDate: number
  /** All open jobs on this tab before filters. */
  totalOpen: number
  /** Open jobs that live on other pages (renewals, tax returns...), counted once each, named from their service card. */
  excluded: ExcludedGroup[]
  anyFilter: boolean
  /** Service steps found duplicated / jobs on a step missing from the settings (both 0 when healthy). */
  warnings: string[]
}
