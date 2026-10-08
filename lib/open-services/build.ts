/**
 * Open services tab — the pure builder (N1a C3, dev job be7da01a). No database, no network, no clock of its own:
 * everything comes in as plain data so every rule is unit-tested.
 *
 * SERVER-ONLY by convention (it imports the canonical status helpers from lib/services/stages.ts, which reach the
 * database client). The browser view imports only types.ts and params.ts. No service name is written in this file.
 */

import { isLiveDeliveryStatus } from "@/lib/services/stages"
import { stageCompletesService } from "@/lib/services/done-step"
import { isWaitingOn } from "@/lib/services/step-settings"
import {
  MAX_LIMIT,
  PAGE_SIZE,
  WHO_GROUP_LABELS,
  WHO_VALUES,
  type ExcludedGroup,
  type FollowUpState,
  type Group,
  type GroupFacts,
  type Row,
  type ViewModel,
  type Who,
} from "@/lib/open-services/types"
import { clampLimit, limitFor, type OpenServicesParams } from "@/lib/open-services/params"

/** Company statuses (lower-cased) that mean the company is not operating: its jobs are parked and never late. */
export const PARKING_COMPANY_STATUSES: readonly string[] = ["suspended", "offboarding", "cancelled", "closed"]

export interface JobInput {
  id: string
  service_type: string
  stage: string | null
  status: string | null
  stage_entered_at: string | null
  created_at: string | null
  account_id: string | null
  contact_id: string | null
  is_test: boolean | null
  service_type_entry_id: string | null
}

export interface StepInput {
  service_type: string
  stage_name: string
  stage_order: number
  waiting_on: string | null
  sla_days: number | null
  completes_service: boolean | null
}

export interface AccountInput {
  id: string
  company_name: string | null
  is_test: boolean | null
  is_internal: boolean | null
  status: string | null
}

export interface ContactInput {
  id: string
  full_name: string | null
  is_test: boolean | null
}

export interface CardInput {
  id: string
  display_name: string | null
  metadata: Record<string, unknown> | null
}

export interface BuildInput {
  jobs: JobInput[]
  steps: StepInput[]
  accounts: AccountInput[]
  contacts: ContactInput[]
  cards: CardInput[]
  now: Date
}

const DAY_MS = 86_400_000

function flagOn(v: unknown): boolean {
  return v === true || v === "true"
}

/** "Closes only by filing" cards sort before "hidden" cards so a job matching both is counted under the first. */
export function excludingCards(cards: CardInput[]): CardInput[] {
  const closes = cards.filter(c => flagOn(c.metadata?.closes_only_by_filing))
  const hidden = cards.filter(c => !flagOn(c.metadata?.closes_only_by_filing) && flagOn(c.metadata?.hidden_from_open_services))
  return [...closes, ...hidden]
}

/**
 * The card that moves this job off the tab, or null. Same match as the database rule for renewals
 * (lib/services/renewal-close.ts `cardClosesOnlyByFiling`): the job's card link OR the job type recorded on the card —
 * needed because some jobs are not linked to their card.
 */
export function matchExcludingCard(
  job: Pick<JobInput, "service_type" | "service_type_entry_id">,
  ordered: CardInput[],
): CardInput | null {
  for (const card of ordered) {
    if (job.service_type_entry_id && card.id === job.service_type_entry_id) return card
    const t = card.metadata?.delivery_service_type
    if (typeof t === "string" && t !== "" && t === job.service_type) return card
  }
  return null
}

function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function stepKey(serviceType: string, stage: string): string {
  return `${serviceType}\u0000${stage}`
}

interface Item {
  row: Row
  entered: number | null
  created: number | null
  nameNorm: string
}

function sinceLabel(ms: number, now: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "America/New_York" }
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "America/New_York" }).format(d)
  const d = new Date(ms)
  return year(d) === year(now)
    ? new Intl.DateTimeFormat("en-US", opts).format(d)
    : new Intl.DateTimeFormat("en-US", { ...opts, year: "numeric" }).format(d)
}

export interface Classified {
  items: Item[]
  excluded: ExcludedGroup[]
  warnings: string[]
}

/** Open jobs → rows (unfiltered), plus how many open jobs live on other pages. */
export function classify(input: BuildInput): Classified {
  const { now } = input
  const accounts = new Map(input.accounts.map(a => [a.id, a]))
  const contacts = new Map(input.contacts.map(c => [c.id, c]))
  const ordered = excludingCards(input.cards)

  // Steps: exact name first, then a trimmed/lower-case fallback. Duplicate names → lowest step number (counted).
  const exact = new Map<string, StepInput>()
  const loose = new Map<string, StepInput>()
  const byService = new Map<string, StepInput[]>()
  let duplicates = 0
  for (const s of input.steps) {
    const list = byService.get(s.service_type) ?? []
    list.push(s)
    byService.set(s.service_type, list)
    const k = stepKey(s.service_type, s.stage_name)
    const prior = exact.get(k)
    if (prior) {
      duplicates++
      if (s.stage_order < prior.stage_order) exact.set(k, s)
    } else exact.set(k, s)
    const lk = stepKey(s.service_type, s.stage_name.trim().toLowerCase())
    const priorLoose = loose.get(lk)
    if (!priorLoose || s.stage_order < priorLoose.stage_order) loose.set(lk, s)
  }
  const rank = new Map<string, number>()
  for (const [svc, list] of Array.from(byService.entries())) {
    const sorted = [...list].sort((a, b) => a.stage_order - b.stage_order)
    sorted.forEach((s, i) => {
      const k = stepKey(svc, s.stage_name)
      if (!rank.has(k)) rank.set(k, i + 1)
    })
  }

  const excludedCount = new Map<string, { label: string; count: number }>()
  const items: Item[] = []
  let orphan = 0

  for (const job of input.jobs) {
    if (!isLiveDeliveryStatus(job.status)) continue
    if (job.is_test === true) continue

    const account = job.account_id ? accounts.get(job.account_id) ?? null : null
    const contact = !job.account_id && job.contact_id ? contacts.get(job.contact_id) ?? null : null
    if (account && (account.is_test === true || account.is_internal === true)) continue
    if (contact && contact.is_test === true) continue

    const card = matchExcludingCard(job, ordered)
    if (card) {
      const label = card.display_name?.trim() || "Other services"
      const prior = excludedCount.get(card.id)
      if (prior) prior.count++
      else excludedCount.set(card.id, { label, count: 1 })
      continue
    }

    const stage = job.stage ?? ""
    const step = (stage ? exact.get(stepKey(job.service_type, stage)) : undefined)
      ?? (stage ? loose.get(stepKey(job.service_type, stage.trim().toLowerCase())) : undefined)
    const badges: string[] = []
    if (!step) {
      orphan++
      badges.push("step not in settings")
    }

    let who: Who = "unset"
    if (step) {
      if (stageCompletesService({ stage_name: step.stage_name, stage_order: step.stage_order, completes_service: step.completes_service }, job.service_type)) {
        who = "none"
      } else if (isWaitingOn(step.waiting_on)) {
        who = step.waiting_on
      }
    }

    const status = (job.status ?? "").trim().toLowerCase()
    const accountStatus = (account?.status ?? "").trim().toLowerCase()
    let parked = false
    if (status === "blocked") { parked = true; badges.push("blocked") }
    if (status === "on_hold" || status === "on hold") { parked = true; badges.push("on hold") }
    // A company that is not operating (suspended / offboarding / cancelled / closed) parks its jobs. A company that is
    // pending formation or delinquent is LIVE work — its jobs must be able to run late — so those only get a badge.
    if (account && accountStatus !== "" && accountStatus !== "active") {
      if (PARKING_COMPANY_STATUSES.includes(accountStatus)) parked = true
      badges.push(`company ${accountStatus}`)
    }

    const enteredMs = parseMs(job.stage_entered_at)
    const daysHere = enteredMs === null ? null : Math.max(0, Math.floor((now.getTime() - enteredMs) / DAY_MS))
    const sla = step && Number.isFinite(step.sla_days) && (step.sla_days as number) > 0 ? (step.sla_days as number) : null

    let followUp: FollowUpState
    let lateBy: number | null = null
    let daysLeft: number | null = null
    if (parked) followUp = "parked"
    else if (daysHere === null) followUp = "no-date"
    else if (who === "date") followUp = "date-step"
    else if (sla === null) followUp = "no-follow-up"
    else if (daysHere > sla) { followUp = "late"; lateBy = daysHere - sla }
    else { followUp = "left"; daysLeft = sla - daysHere }

    const name = account
      ? account.company_name?.trim() || "Unnamed company"
      : contact
        ? contact.full_name?.trim() || "Unnamed person"
        : "(no company or person)"

    const row: Row = {
      id: job.id,
      serviceType: job.service_type,
      name,
      isPerson: !account,
      stage,
      stepNo: step ? rank.get(stepKey(step.service_type, step.stage_name)) ?? null : null,
      who,
      sinceLabel: enteredMs === null ? null : sinceLabel(enteredMs, now),
      daysHere,
      followUpDays: sla,
      lateBy,
      daysLeft,
      followUp,
      badges,
      href: `/flows/${job.id}`,
    }
    items.push({ row, entered: enteredMs, created: parseMs(job.created_at), nameNorm: normalizeName(name) })
  }

  const warnings: string[] = []
  if (duplicates > 0) warnings.push(`${duplicates} service step name(s) are duplicated; the lowest-numbered one is used.`)
  if (orphan > 0) warnings.push(`${orphan} open job(s) sit on a step that is not in the service's step list.`)

  return {
    items,
    excluded: Array.from(excludedCount.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    warnings,
  }
}

/** Total order: most late first, then oldest step date, then oldest job, then id. Nulls last. */
export function compareItems(a: Item, b: Item): number {
  const la = a.row.lateBy ?? -1
  const lb = b.row.lateBy ?? -1
  if (la !== lb) return lb - la
  const ea = a.entered ?? Number.POSITIVE_INFINITY
  const eb = b.entered ?? Number.POSITIVE_INFINITY
  if (ea !== eb) return ea < eb ? -1 : 1
  const ca = a.created ?? Number.POSITIVE_INFINITY
  const cb = b.created ?? Number.POSITIVE_INFINITY
  if (ca !== cb) return ca < cb ? -1 : 1
  return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0
}

function groupFacts(items: Item[]): GroupFacts {
  return {
    total: items.length,
    noDate: items.filter(i => i.row.daysHere === null).length,
    late: items.filter(i => i.row.lateBy !== null).length,
    notSet: items.filter(i => i.row.who === "unset").length,
    parked: items.filter(i => i.row.followUp === "parked").length,
  }
}

export function buildViewModel(classified: Classified, params: OpenServicesParams, now: Date): ViewModel {
  const q = normalizeName(params.q)
  const whoSet = new Set<Who>(params.who)

  const passesQuery = (i: Item) => q === "" || i.nameNorm.includes(q)
  const passesLate = (i: Item) => !params.late || i.row.lateBy !== null
  const passesWho = (i: Item) => whoSet.size === 0 || whoSet.has(i.row.who)

  const all = classified.items
  const filtered = all.filter(i => passesQuery(i) && passesLate(i) && passesWho(i))

  // Chip counts: every filter EXCEPT the who filter (so the other chips keep showing what they would add).
  const chips = Object.fromEntries(WHO_VALUES.map(w => [w, 0])) as Record<Who, number>
  for (const i of all) if (passesQuery(i) && passesLate(i)) chips[i.row.who]++
  const lateChip = all.filter(i => passesQuery(i) && passesWho(i) && i.row.lateBy !== null).length

  // Groups.
  const byKey = new Map<string, { label: string; all: Item[]; filtered: Item[] }>()
  const keyOf = (i: Item) => (params.view === "service" ? i.row.serviceType : i.row.who)
  const labelOf = (key: string) => (params.view === "service" ? key : WHO_GROUP_LABELS[key as Who])
  for (const i of all) {
    const k = keyOf(i)
    if (!byKey.has(k)) byKey.set(k, { label: labelOf(k), all: [], filtered: [] })
    byKey.get(k)!.all.push(i)
  }
  for (const i of filtered) byKey.get(keyOf(i))!.filtered.push(i)

  const anyFilter = q !== "" || params.late || whoSet.size > 0

  const groups: Group[] = []
  for (const [key, g] of Array.from(byKey.entries())) {
    if (g.filtered.length === 0 && anyFilter) continue
    const sorted = [...g.filtered].sort(compareItems)
    const limit = clampLimit(limitFor(params, key))
    const shownRows = sorted.slice(0, limit)
    const allUnset = g.all.length > 0 && g.all.every(i => i.row.who === "unset")
    // Collapsed unless a filter matches inside, or the visitor opened it by hand (a 'more' entry for the group).
    const openedByHand = params.more.some(([k]) => k === key)
    const collapsed = allUnset && !openedByHand && !(anyFilter && g.filtered.length > 0)
    groups.push({
      key,
      label: g.label,
      rows: shownRows.map(i => i.row),
      total: sorted.length,
      limit,
      hasMore: sorted.length > shownRows.length,
      capped: sorted.length > shownRows.length && limit >= MAX_LIMIT,
      nextLimit: clampLimit(limit + PAGE_SIZE),
      collapsed,
      facts: groupFacts(sorted),
    })
  }

  if (params.view === "who") {
    groups.sort((a, b) => WHO_VALUES.indexOf(a.key as Who) - WHO_VALUES.indexOf(b.key as Who))
  } else {
    groups.sort((a, b) => b.facts.late - a.facts.late || a.label.localeCompare(b.label))
  }

  return {
    asOf: now.toISOString(),
    view: params.view,
    groups,
    chips,
    lateChip,
    shown: filtered.length,
    late: filtered.filter(i => i.row.lateBy !== null).length,
    noDate: filtered.filter(i => i.row.daysHere === null).length,
    totalOpen: all.length,
    excluded: classified.excluded,
    anyFilter,
    warnings: classified.warnings,
  }
}

/** The one call the page makes after loading: classify, filter, group. */
export function buildOpenServices(input: BuildInput, params: OpenServicesParams): ViewModel {
  return buildViewModel(classify(input), params, input.now)
}
