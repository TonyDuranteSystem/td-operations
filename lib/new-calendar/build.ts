/**
 * New Calendar — the pure builder (dev job 40235e3c, child of be7da01a). No database, no network, no clock of its own:
 * everything comes in as plain data so every rule is unit-tested.
 *
 * It sits on top of the Open services classifier (lib/open-services/build.ts: which jobs are open, whose turn it is,
 * what is late, which jobs live on other pages) and adds ONE thing: the four lists of the morning view (To work on /
 * Pending / Not sorted yet / Closed). SERVER-ONLY by convention (the classifier imports the status helpers that reach the
 * database client). The browser view imports only types.ts, params.ts and greeting.ts. No service or step name is written
 * in this file: every service and step shown comes from the step settings.
 */

import { stageCompletesService } from "@/lib/services/done-step"
import { isWaitingOn } from "@/lib/services/step-settings"
import {
  classify,
  compareItems,
  excludingCards,
  matchExcludingCard,
  normalizeName,
  type AccountInput,
  type BuildInput,
  type Classified,
  type ContactInput,
} from "@/lib/open-services/build"
import type { Row, Who } from "@/lib/open-services/types"
import {
  CLOSED_WINDOW_DAYS,
  MAX_LIMIT,
  type Bucket,
  type CalendarModel,
  type CalendarRow,
  type Pill,
  type ServiceChip,
  type StepChip,
} from "@/lib/new-calendar/types"
import { sameText, sameTextLoose, type NewCalendarParams } from "@/lib/new-calendar/params"

const DAY_MS = 86_400_000

/** A job that is finished (status completed), as the loader reads it. */
export interface ClosedJobInput {
  id: string
  service_type: string
  stage: string | null
  account_id: string | null
  contact_id: string | null
  is_test: boolean | null
  service_type_entry_id: string | null
  /** A calendar date ("2026-10-02") when someone recorded the end; null otherwise. */
  end_date: string | null
  /** When the job last moved to a step; for a finished job, the day it reached its last step. */
  stage_entered_at: string | null
}

export interface NewCalendarInput extends BuildInput {
  closed: ClosedJobInput[]
}

type OpenItem = Classified["items"][number]

interface OpenEntry {
  item: OpenItem
  bucket: Bucket
}

interface ClosedEntry {
  row: CalendarRow
  nameNorm: string
  finished: number
}

/** Whose turn it is, in the words the page uses after "Waiting on". */
const WAIT_WORDS: Record<Who, string> = {
  us: "us",
  client: "the client",
  outside: "an outside office",
  date: "a date",
  none: "nobody",
  unset: "",
}

/**
 * Which list an OPEN job belongs to. Every open job is in exactly one list.
 *   - a paused job (blocked, on hold, company not operating) waits: Pending, never counted late;
 *   - a follow-up that ran late comes back to To work on, whoever it was waiting for;
 *   - a step that is ours, or the last step (nobody is waiting: close it): To work on;
 *   - a step with no waiting-on setting: Not sorted yet (the page will not guess);
 *   - client / outside office / a date: Pending.
 */
export function bucketOf(row: Row): Bucket {
  if (row.followUp === "parked") return "pending"
  if (row.lateBy !== null) return "work"
  if (row.who === "us" || row.who === "none") return "work"
  if (row.who === "unset") return "other"
  return "pending"
}

/** The action in plain words for an OPEN job. */
export function nextText(row: Row): string {
  if (row.followUp === "parked") {
    const why = row.badges.filter(b => b !== "step not in settings")
    return why.length > 0 ? `Paused: ${why.join(", ")}` : "Paused"
  }
  const stage = row.stage.trim()
  if (stage === "") return "No step recorded"
  if (row.lateBy !== null) return `Follow up: ${stage}`
  switch (row.who) {
    case "us":
      return `Do: ${stage}`
    case "none":
      return "Last step reached: close it"
    case "unset":
      return "Waiting-on not set for this step"
    default:
      return `Waiting on ${WAIT_WORDS[row.who]}: ${stage}`
  }
}

function pillOf(row: Row, bucket: Bucket): Pill {
  if (bucket === "work" && row.lateBy !== null) return "late"
  return bucket
}

function toOpenRow(e: OpenEntry): CalendarRow {
  const r = e.item.row
  return {
    id: r.id,
    name: r.name,
    isPerson: r.isPerson,
    serviceType: r.serviceType,
    stage: r.stage,
    stepNo: r.stepNo,
    bucket: e.bucket,
    pill: pillOf(r, e.bucket),
    who: r.who,
    daysHere: r.daysHere,
    lateBy: r.lateBy,
    finishedLabel: null,
    next: nextText(r),
    badges: r.badges,
    href: r.href,
    popup: r.popup,
  }
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** When a finished job finished: the recorded end date if there is one (noon UTC, so no time zone moves the day), else the day it reached its last step. */
export function finishedAt(job: Pick<ClosedJobInput, "end_date" | "stage_entered_at">): number | null {
  if (job.end_date) {
    const ms = Date.parse(`${job.end_date.slice(0, 10)}T12:00:00Z`)
    if (Number.isFinite(ms)) return ms
  }
  return parseMs(job.stage_entered_at)
}

function dayLabel(ms: number, now: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "America/New_York" }
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "America/New_York" }).format(d)
  const d = new Date(ms)
  return year(d) === year(now)
    ? new Intl.DateTimeFormat("en-US", opts).format(d)
    : new Intl.DateTimeFormat("en-US", { ...opts, year: "numeric" }).format(d)
}

/**
 * Finished jobs of the last CLOSED_WINDOW_DAYS days. Same people rules as the open list: test jobs, test / internal
 * companies and test people never show, and a job that lives on another page (a renewal, a tax return) is left to that page.
 */
export function classifyClosed(input: NewCalendarInput, openIds: ReadonlySet<string> = new Set()): ClosedEntry[] {
  const { now } = input
  const accounts = new Map<string, AccountInput>(input.accounts.map(a => [a.id, a]))
  const contacts = new Map<string, ContactInput>(input.contacts.map(c => [c.id, c]))
  const ordered = excludingCards(input.cards)
  const oldest = now.getTime() - CLOSED_WINDOW_DAYS * DAY_MS
  const newest = now.getTime() + DAY_MS

  const out: ClosedEntry[] = []
  for (const job of input.closed) {
    // The open and finished reads are separate: a job finished in between could be read by both. It stays in the open list.
    if (openIds.has(job.id)) continue
    if (job.is_test === true) continue
    const account = job.account_id ? accounts.get(job.account_id) ?? null : null
    const contact = !job.account_id && job.contact_id ? contacts.get(job.contact_id) ?? null : null
    if (account && (account.is_test === true || account.is_internal === true)) continue
    if (contact && contact.is_test === true) continue
    if (matchExcludingCard(job, ordered)) continue

    const finished = finishedAt(job)
    if (finished === null || finished < oldest || finished > newest) continue

    const name = account
      ? account.company_name?.trim() || "Unnamed company"
      : contact
        ? contact.full_name?.trim() || "Unnamed person"
        : "(no company or person)"
    out.push({
      nameNorm: normalizeName(name),
      finished,
      row: {
        id: job.id,
        name,
        isPerson: !account,
        serviceType: job.service_type,
        stage: job.stage ?? "",
        stepNo: null,
        bucket: "closed",
        pill: "closed",
        who: "none",
        daysHere: null,
        lateBy: null,
        finishedLabel: dayLabel(finished, now),
        next: "Finished",
        badges: [],
        href: `/flows/${job.id}`,
        popup: null,
      },
    })
  }
  return out
}

function countBy(names: string[]): ServiceChip[] {
  const m = new Map<string, number>()
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1)
  return Array.from(m.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/** A service's own steps, in order, from the settings — with how many open jobs sit on each. */
function stepChips(input: NewCalendarInput, service: string, open: OpenEntry[]): StepChip[] {
  const own = input.steps
    .filter(s => sameText(s.service_type, service))
    .sort((a, b) => a.stage_order - b.stage_order)
  const seen = new Set<string>()
  const chips: StepChip[] = []
  for (const s of own) {
    const key = norm(s.stage_name)
    if (seen.has(key)) continue
    seen.add(key)
    let waitingOn: Who = "unset"
    if (stageCompletesService({ stage_name: s.stage_name, stage_order: s.stage_order, completes_service: s.completes_service }, service)) {
      waitingOn = "none"
    } else if (isWaitingOn(s.waiting_on)) {
      waitingOn = s.waiting_on
    }
    const count = open.filter(e => sameText(e.item.row.serviceType, service) && sameTextLoose(e.item.row.stage, s.stage_name)).length
    chips.push({ name: s.stage_name, count, waitingOn })
  }
  return chips
}

/** The one call the page makes after loading: classify, sort into lists, filter, page. */
export function buildNewCalendar(input: NewCalendarInput, params: NewCalendarParams): CalendarModel {
  const { now } = input
  const classified = classify(input)
  const q = normalizeName(params.q)
  const passesQuery = (nameNorm: string) => q === "" || nameNorm.includes(q)

  const open: OpenEntry[] = classified.items.map(item => ({ item, bucket: bucketOf(item.row) }))
  const closed = classifyClosed(input, new Set(open.map(e => e.item.row.id)))

  // The two numbers that never move with a search or a filter.
  const workToday = open.filter(e => e.bucket === "work").length
  const openTotal = open.length

  const openQ = open.filter(e => passesQuery(e.item.nameNorm))
  const closedQ = closed.filter(c => passesQuery(c.nameNorm))
  const counts: Record<Bucket, number> = {
    work: openQ.filter(e => e.bucket === "work").length,
    pending: openQ.filter(e => e.bucket === "pending").length,
    other: openQ.filter(e => e.bucket === "other").length,
    closed: closedQ.length,
  }

  // A step chosen on the chips shows EVERY open job on that step, whichever list it is in; it needs a service and an open list.
  const stepView = params.s !== "" && params.st !== "" && params.b !== "closed"
  const active: Bucket | null = stepView ? null : params.b

  // Service chips always describe the list the visitor chose (so choosing a step does not rebuild the row of chips).
  const services = countBy(
    params.b === "closed"
      ? closedQ.map(c => c.row.serviceType)
      : openQ.filter(e => e.bucket === params.b).map(e => e.item.row.serviceType),
  )

  const steps = params.s !== "" && params.b !== "closed" ? stepChips(input, params.s, openQ) : []

  let rows: CalendarRow[]
  let total: number
  if (stepView) {
    const picked = openQ
      .filter(e => sameText(e.item.row.serviceType, params.s) && sameTextLoose(e.item.row.stage, params.st))
      .sort((a, b) => compareItems(a.item, b.item))
    total = picked.length
    rows = picked.slice(0, params.n).map(toOpenRow)
  } else if (params.b === "closed") {
    const picked = closedQ
      .filter(c => params.s === "" || sameText(c.row.serviceType, params.s))
      .sort((a, b) => b.finished - a.finished || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0))
    total = picked.length
    rows = picked.slice(0, params.n).map(c => c.row)
  } else {
    const picked = openQ
      .filter(e => e.bucket === params.b && (params.s === "" || sameText(e.item.row.serviceType, params.s)))
      .sort((a, b) => compareItems(a.item, b.item))
    total = picked.length
    rows = picked.slice(0, params.n).map(toOpenRow)
  }

  return {
    asOf: now.toISOString(),
    workToday,
    openTotal,
    counts,
    active,
    services,
    steps,
    rows,
    total,
    hasMore: total > rows.length,
    capped: total > rows.length && params.n >= MAX_LIMIT,
    excluded: classified.excluded,
    warnings: classified.warnings,
  }
}
