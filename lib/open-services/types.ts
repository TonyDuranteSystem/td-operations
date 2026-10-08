/**
 * Open services tab — shared shapes and labels (N1a C3).
 *
 * PURE and client-safe on purpose: the client view imports ONLY this file and params.ts, never build.ts / load.ts /
 * audience.ts (those reach the server-only database client). A source test pins that boundary.
 */

/** The six "who must move next" states. The first five are the step setting `waiting_on`; 'unset' = not set. */
export const WHO_VALUES = ["us", "client", "outside", "date", "none", "unset"] as const
export type Who = (typeof WHO_VALUES)[number]

export const WHO_LABELS: Record<Who, string> = {
  us: "Us",
  client: "Client",
  outside: "Outside office",
  date: "A date",
  none: "Nobody (close it?)",
  unset: "Not set",
}

export const WHO_GROUP_LABELS: Record<Who, string> = {
  us: "Waiting on us",
  client: "Waiting on the client",
  outside: "Waiting on an outside office",
  date: "Waiting on a date",
  none: "Nobody is waiting (close it?)",
  unset: "Waiting-on not set",
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
  /** Job counts per "waiting on" state, with every filter applied EXCEPT the who filter. */
  chips: Record<Who, number>
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
