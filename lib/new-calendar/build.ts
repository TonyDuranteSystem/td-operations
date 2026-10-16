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
import { resolveWho } from "@/lib/open-services/wait-kinds"
import { UNSET_LABELS, defaultWaitKinds, firstKindWith, waitKindOf, type Row, type WaitKind } from "@/lib/open-services/types"
import {
  CLOSED_WINDOW_DAYS,
  MAX_LIMIT,
  PAUSED_KEY,
  type Bucket,
  type ListKey,
  type CalendarModel,
  type CalendarRow,
  type Pill,
  type ServiceChip,
  type StepChip,
  type WaitChip,
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

/**
 * Which list an OPEN job belongs to. Every open job is in exactly one list.
 *   - a paused job (blocked, on hold, company not operating) waits: Pending, never counted late;
 *   - a step with no waiting-on setting: Not sorted yet (the page will not guess, late or not);
 *   - a follow-up that ran late comes back to To work on, whoever it was waiting for;
 *   - a step that is ours, or the last step (nobody is waiting: close it): To work on;
 *   - waiting on the client, an outside office, a date (any kind from the waiting-on list): Pending.
 */
export function bucketOf(row: Row): Bucket {
  if (row.followUp === "parked") return "pending"
  // No waiting-on setting = the page cannot tell whose turn it is, so it does not guess: not even a late one goes to To work on
  // (System Counselor, 2026-10-16: 5 mailing-address jobs would otherwise be "overdue" next to 221 identical ones "not sorted").
  // Its lateness still shows in red in the Days column.
  if (row.behaviour === null) return "other"
  if (row.lateBy !== null) return "work"
  if (row.behaviour === "ours" || row.behaviour === "none") return "work"
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
  switch (row.behaviour) {
    case "ours":
      return `Do: ${stage}`
    case "none":
      return "Last step reached: close it"
    case null:
      return "Waiting-on not set for this step"
    default:
      return `Waiting on ${row.whoPhrase}: ${stage}`
  }
}

/** The words in the status pill. A waiting job says who it waits on; a paused one says so. */
export function pillLabelOf(row: Row, bucket: Bucket): string {
  if (bucket === "work") return row.lateBy !== null ? "Overdue" : "To work on"
  if (bucket === "pending") return row.followUp === "parked" ? "Paused" : `Waiting on ${row.whoPhrase}`
  if (bucket === "other") return "Not sorted"
  return "Closed"
}

/** The order of the open buckets inside "All open". */
const BUCKET_RANK: Record<Bucket, number> = { work: 0, pending: 1, other: 2, closed: 3 }

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
    pillLabel: pillLabelOf(r, e.bucket),
    who: r.who,
    behaviour: r.behaviour,
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
  const noneKind = firstKindWith(input.waitKinds ?? defaultWaitKinds(), "none")
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
        pillLabel: "Closed",
        who: noneKind?.slug ?? "none",
        behaviour: "none",
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
function stepChips(input: NewCalendarInput, kinds: readonly WaitKind[], service: string, open: OpenEntry[]): StepChip[] {
  const own = input.steps
    .filter(s => sameText(s.service_type, service))
    .sort((a, b) => a.stage_order - b.stage_order)
  const seen = new Set<string>()
  const chips: StepChip[] = []
  for (const s of own) {
    const key = norm(s.stage_name)
    if (seen.has(key)) continue
    seen.add(key)
    const done = stageCompletesService({ stage_name: s.stage_name, stage_order: s.stage_order, completes_service: s.completes_service }, service)
    const resolved = resolveWho(kinds, s.waiting_on, done)
    const waitingOn = resolved.who
    const kind = waitKindOf(kinds, waitingOn)
    const count = open.filter(e => sameText(e.item.row.serviceType, service) && sameTextLoose(e.item.row.stage, s.stage_name)).length
    chips.push({ name: s.stage_name, count, waitingOn, behaviour: kind?.behaviour ?? null, tip: kind?.tip ?? (resolved.dangling !== null ? `Set to "${resolved.dangling}", which is no longer in the waiting-on list` : UNSET_LABELS.tip) })
  }
  return chips
}

/** The one call the page makes after loading: classify, sort into lists, filter, page. */
export function buildNewCalendar(input: NewCalendarInput, params: NewCalendarParams): CalendarModel {
  const { now } = input
  const classified = classify(input)
  const kinds = classified.kinds
  const q = normalizeName(params.q)
  const passesQuery = (nameNorm: string) => q === "" || nameNorm.includes(q)

  const open: OpenEntry[] = classified.items.map(item => ({ item, bucket: bucketOf(item.row) }))
  const closed = classifyClosed(input, new Set(open.map(e => e.item.row.id)))

  // The two numbers that never move with a search or a filter.
  const workToday = open.filter(e => e.bucket === "work").length
  const openTotal = open.length

  const openQ = open.filter(e => passesQuery(e.item.nameNorm))
  const closedQ = closed.filter(c => passesQuery(c.nameNorm))
  const counts: Record<ListKey, number> = {
    all: openQ.length,
    work: openQ.filter(e => e.bucket === "work").length,
    pending: openQ.filter(e => e.bucket === "pending").length,
    other: openQ.filter(e => e.bucket === "other").length,
    closed: closedQ.length,
  }

  // A step chosen on the chips shows EVERY open job on that step, whichever list it is in; it needs a service and an open list.
  const stepView = params.s !== "" && params.st !== "" && params.b !== "closed"
  const active: ListKey | null = stepView ? null : params.b

  // The "Waiting on" row: only on the Pending list. One chip per kind of wait that has jobs there (plus the paused ones), counted with the
  // search and the service applied but NOT the chip itself. A chip typed in the address that is not a real kind is ignored.
  // Which open jobs the chosen list holds ("all" = every open job; the others = that bucket).
  const inList = (e: OpenEntry) => params.b === "all" || e.bucket === params.b
  const onPending = !stepView && params.b === "pending"
  const pendingScope = onPending ? openQ.filter(e => e.bucket === "pending" && (params.s === "" || sameText(e.item.row.serviceType, params.s))) : []
  const keyOf = (e: OpenEntry) => (e.item.row.followUp === "parked" ? PAUSED_KEY : e.item.row.who)
  const waitCounts = new Map<string, number>()
  for (const e of pendingScope) waitCounts.set(keyOf(e), (waitCounts.get(keyOf(e)) ?? 0) + 1)
  const waitKind = waitKindOf(kinds, params.w)
  const validWait = params.w === PAUSED_KEY || (waitKind !== null && waitKind.behaviour !== "ours" && waitKind.behaviour !== "none")
  const waitFilter = onPending && validWait ? params.w : ""
  const waiting: WaitChip[] = onPending
    ? [
        ...kinds
          .filter(k => k.behaviour !== "ours" && k.behaviour !== "none")
          .map(k => ({ key: k.slug, label: k.chip, count: waitCounts.get(k.slug) ?? 0, behaviour: k.behaviour as WaitChip["behaviour"] })),
        { key: PAUSED_KEY, label: "Paused", count: waitCounts.get(PAUSED_KEY) ?? 0, behaviour: null },
      ].filter(c => c.count > 0 || c.key === waitFilter)
    : []

  // Service chips always describe the list the visitor chose (so choosing a step does not rebuild the row of chips).
  const services = countBy(
    params.b === "closed"
      ? closedQ.map(c => c.row.serviceType)
      : openQ.filter(e => inList(e) && (waitFilter === "" || keyOf(e) === waitFilter)).map(e => e.item.row.serviceType),
  )

  const steps = params.s !== "" && params.b !== "closed" ? stepChips(input, kinds, params.s, openQ) : []



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
      .filter(e => inList(e) && (params.s === "" || sameText(e.item.row.serviceType, params.s)) && (waitFilter === "" || keyOf(e) === waitFilter))
      // In "All open" the jobs that are on us come first, then the ones that wait, then the ones not sorted; inside each, the usual order.
      .sort((a, b) => BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] || compareItems(a.item, b.item))
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
    waiting,
    waitFilter,
    rows,
    total,
    hasMore: total > rows.length,
    capped: total > rows.length && params.n >= MAX_LIMIT,
    excluded: classified.excluded,
    warnings: classified.warnings,
  }
}
