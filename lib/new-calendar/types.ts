/**
 * New Calendar — shared shapes and labels (dev job 40235e3c, child of be7da01a).
 *
 * PURE and client-safe on purpose: the view imports ONLY this file, params.ts and greeting.ts, never build.ts / load.ts
 * (those reach the server-only database client). A source test pins that boundary. No service or step name is written
 * anywhere in lib/new-calendar: every service and step on the page comes from the step settings (the data).
 */

import type { CalendarPopup, WaitBehaviour, Who } from "@/lib/open-services/types"

/** The four lists of the page. "other" = jobs whose step has no "waiting on" setting yet (so they cannot be sorted honestly). */
export const BUCKETS = ["work", "pending", "other", "closed"] as const
export type Bucket = (typeof BUCKETS)[number]

/** The lists on screen: "All open" (every open job: To work on + Pending + Not sorted yet) first, then the four lists. A JOB is always in one
 *  Bucket; "all" is only a way of looking at them together (Antonio 2026-10-16: see the stage of everything, not only what is on us). */
export const LISTS = ["all", ...BUCKETS] as const
export type ListKey = (typeof LISTS)[number]

export const LIST_LABELS: Record<ListKey, string> = {
  all: "All open",
  work: "To work on",
  pending: "Pending",
  other: "Not sorted yet",
  closed: "Closed · last 30 days",
}

/** Kept under the old name for the code that labels a job's own list. */
export const BUCKET_LABELS = LIST_LABELS

export const BUCKET_HELP: Record<ListKey, string> = {
  all: "Every open job, with its step and who the next move belongs to: the jobs that are on us first, then the ones waiting on someone else, then the ones not sorted yet.",
  work: "Steps that are ours, jobs whose follow-up time has passed, and jobs sitting on the last step (nobody is waiting: close them).",
  pending: "Steps waiting on someone else (any kind of wait in the waiting-on list), and paused jobs (blocked, on hold, company not operating). Use the \"Waiting on\" chips to see one kind of wait.",
  other: "The step has no usable \"waiting on\" setting (none, or a kind that is no longer in the list), so the page cannot tell whose turn it is. Set it on the step in the Service Catalog.",
  closed: "Jobs that reached their last step in the last 30 days.",
}

/** Days a finished job stays listed under Closed. */
export const CLOSED_WINDOW_DAYS = 30

export const PAGE_SIZE = 50
export const MAX_LIMIT = 5000
export const MAX_TEXT_LENGTH = 80

/** The "Waiting on" chip that shows the paused jobs of the Pending list (blocked, on hold, company not operating). */
export const PAUSED_KEY = "paused"

export type Pill = "late" | "work" | "pending" | "other" | "closed"

export const PILL_LABELS: Record<Pill, string> = {
  late: "Overdue",
  work: "To work on",
  pending: "Pending",
  other: "Not sorted",
  closed: "Closed",
}

export interface CalendarRow {
  id: string
  /** Company name, or the person's name for a job that belongs to a person. */
  name: string
  isPerson: boolean
  /** The company and the person the job is tied to — lets a sticky note made from the row be tagged. */
  accountId?: string | null
  contactId?: string | null
  /** The team notes on this job (set by the page after the notes are read; absent = none read). */
  notes?: { count: number; last: { id: string; body: string; authorName: string; createdAt: string } | null } | null
  serviceType: string
  /** The step the job sits on (for a closed job: the step it finished on). */
  stage: string
  /** Position of the step in its service's step list (1-based), from the settings; null when unknown. */
  stepNo: number | null
  bucket: Bucket
  pill: Pill
  /** The words in the status pill: "Overdue", "To work on", "Waiting on the client", "Paused"... */
  pillLabel: string
  who: Who
  /** What `who` means (null = no setting). */
  behaviour: WaitBehaviour | null
  /** Days on the current step; null when the job has no step date (and for closed jobs). */
  daysHere: number | null
  /** Days past the follow-up time; set only when strictly greater than zero. */
  lateBy: number | null
  /** "Apr 7" the job reached its last step / was marked ended; closed rows only. */
  finishedLabel: string | null
  /** The action in plain words ("Follow up: ...", "Waiting on the client: ...", "Do: ..."). */
  next: string
  /** Plain-words flags: "blocked", "on hold", "company closed", "step not in settings". */
  badges: string[]
  href: string
  /** The Calendar pop-up this job's step asks for (from the step's layout), or null: then the row links to the job page. */
  popup: CalendarPopup | null
}

export interface ServiceChip {
  name: string
  count: number
}

export interface StepChip {
  name: string
  count: number
  /** Who the step waits on, from the settings. */
  waitingOn: Who
  /** What that means (null = no setting): colours the chip's dot. */
  behaviour: WaitBehaviour | null
  /** Plain words for the dot's tooltip ("Waiting on the client", "Our turn"...). */
  tip: string
}

/** One chip of the "Waiting on" row on the Pending list. `key` is a kind slug or PAUSED_KEY. */
export interface WaitChip {
  key: string
  label: string
  count: number
  behaviour: WaitBehaviour | null
}

export interface ExcludedLine {
  label: string
  count: number
}

export interface CalendarModel {
  asOf: string
  /** Jobs to work on today: the To work on list, NOT affected by search or any filter. */
  workToday: number
  /** Open jobs on this page (To work on + Pending + Not sorted yet), NOT affected by search or any filter. */
  openTotal: number
  /** Jobs per list, with the search applied (so a company search shows where its jobs are). */
  counts: Record<ListKey, number>
  /** The list on screen, or null when a step filter is showing jobs from every open list. */
  active: ListKey | null
  /** Services present in the list the visitor chose (with the search applied). */
  services: ServiceChip[]
  /** That service's own steps, from its settings; empty unless a service is chosen on an open list. */
  steps: StepChip[]
  /** The "Waiting on" chips (Pending list only; empty elsewhere), counted with the search and the service applied. */
  waiting: WaitChip[]
  /** The chip chosen on the row ("" = all), already checked against the real kinds. */
  waitFilter: string
  rows: CalendarRow[]
  /** Jobs in the view before paging. */
  total: number
  hasMore: boolean
  /** More exist but the page ceiling is reached: say "narrow the search", don't offer "Show more". */
  capped: boolean
  /** Open jobs that live on other pages (renewals, tax returns...), counted once each, named from their service card. */
  excluded: ExcludedLine[]
  warnings: string[]
}
