/**
 * One-time (repeatable) import of OLDER leads from Meta (TD Marketing, dev job 9aec66fa — Antonio, 2026-10-23: "import the 17 and 18 October leads").
 * The 5-minute reconcile only looks at the last 3 days and one page per form; a lead that arrived before the webhook was switched on is never
 * seen. This walks each form's leads from newest to oldest (Meta keeps them about 90 days) and keeps those that arrived in [since, until).
 * Every lead goes through the SAME ingest as a live one, which stores a lead once (unique on its Meta id): running it twice, or over days we
 * already hold, adds nothing. `dryRun` only counts: nothing is written. Pure orchestration — Meta, the clock and the database come in as deps.
 */
import type { GraphLead } from "@/lib/marketing/meta-leads/map-lead"
import { ingestLeadgenEvent, type IngestDeps } from "@/lib/marketing/meta-leads/ingest"

export const IMPORT_MAX_PAGES_PER_FORM = 40
export const IMPORT_MAX_DAYS = 100

export interface ImportDeps {
  ingest: IngestDeps
  pageIds: string[]
  listForms: (pageId: string) => Promise<Array<{ id: string; name?: string }>>
  listLeadsPage: (formId: string, after: string | null, pageId: string) => Promise<{ leads: GraphLead[]; after: string | null }>
  /** which of these Meta lead ids we already hold */
  alreadyHeld: (leadgenIds: string[]) => Promise<Set<string>>
  /** the day a lead arrived, as "YYYY-MM-DD" in the team's time zone */
  dayOf: (d: Date) => string
  now: () => Date
  /** stop starting new pages after this many ms (the request has a time limit) */
  budgetMs: number
}

export interface ImportDay { day: string; seen: number; alreadyHeld: number; added: number }
export interface ImportResult {
  dryRun: boolean
  forms: number
  seen: number
  alreadyHeld: number
  /** dry run: would be added; real run: stored */
  added: number
  days: ImportDay[]
  /** true when the walk stopped early (time or page limit): run it again */
  stoppedEarly: boolean
  errors: string[]
}

export function checkImportRange(since: unknown, until: unknown, now: Date): { ok: true; since: Date; until: Date } | { ok: false; error: string } {
  const parse = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? new Date(v) : null)
  const s = parse(since), u = parse(until)
  if (!s || !u || Number.isNaN(s.getTime()) || Number.isNaN(u.getTime())) return { ok: false, error: "Pick a start and an end date." }
  if (u <= s) return { ok: false, error: "The end must be after the start." }
  if (u.getTime() > now.getTime() + 24 * 3600_000) return { ok: false, error: "The end date is in the future." }
  if (now.getTime() - s.getTime() > IMPORT_MAX_DAYS * 24 * 3600_000) return { ok: false, error: `Meta keeps leads for about 90 days; pick a start within the last ${IMPORT_MAX_DAYS} days.` }
  if (u.getTime() - s.getTime() > 31 * 24 * 3600_000) return { ok: false, error: "Import at most 31 days at a time." }
  return { ok: true, since: s, until: u }
}

export async function importLeadsFromMeta(deps: ImportDeps, range: { since: Date; until: Date }, dryRun: boolean): Promise<ImportResult> {
  const out: ImportResult = { dryRun, forms: 0, seen: 0, alreadyHeld: 0, added: 0, days: [], stoppedEarly: false, errors: [] }
  const byDay = new Map<string, ImportDay>()
  const started = deps.now().getTime()
  const day = (k: string): ImportDay => { let d = byDay.get(k); if (!d) { d = { day: k, seen: 0, alreadyHeld: 0, added: 0 }; byDay.set(k, d) } return d }
  for (const pageId of deps.pageIds) {
    let forms: Array<{ id: string; name?: string }> = []
    try { forms = await deps.listForms(pageId) } catch (e) { out.errors.push(`page ${pageId}: ${msg(e)}`); continue }
    for (const form of forms) {
      out.forms++
      let after: string | null = null
      for (let page = 0; page < IMPORT_MAX_PAGES_PER_FORM; page++) {
        if (deps.now().getTime() - started > deps.budgetMs) { out.stoppedEarly = true; break }
        let res: { leads: GraphLead[]; after: string | null }
        try { res = await deps.listLeadsPage(form.id, after, pageId) } catch (e) { out.errors.push(`form ${form.id}: ${msg(e)}`); break }
        const stamped = res.leads.map((l) => ({ l, t: l.created_time ? Date.parse(l.created_time) : NaN }))
        const inRange = stamped.filter((x) => Number.isFinite(x.t) && x.t >= range.since.getTime() && x.t < range.until.getTime())
        const held = inRange.length ? await deps.alreadyHeld(inRange.map((x) => String(x.l.id))) : new Set<string>()
        for (const { l, t } of inRange) {
          const d = day(deps.dayOf(new Date(t)))
          out.seen++; d.seen++
          if (held.has(String(l.id))) { out.alreadyHeld++; d.alreadyHeld++; continue }
          if (dryRun) { out.added++; d.added++; continue }
          const r = await ingestLeadgenEvent(deps.ingest, {
            leadgenId: String(l.id), pageId, formId: form.id, adId: l.ad_id ?? null, adgroupId: l.adset_id ?? null, createdTime: new Date(t).toISOString(),
          }, "reconcile", l)
          if (r.status === "stored") { out.added++; d.added++ } else if (r.status === "already_done") { out.alreadyHeld++; d.alreadyHeld++ } else out.errors.push(`lead ${l.id}: ${r.status}`)
        }
        // newest first: once a page reaches back before the start (or Meta has no older page), this form is done
        const oldest = stamped.reduce((m, x) => (Number.isFinite(x.t) && x.t < m ? x.t : m), Infinity)
        if (!res.after || res.leads.length === 0 || oldest < range.since.getTime()) break
        after = res.after
        if (page === IMPORT_MAX_PAGES_PER_FORM - 1) out.stoppedEarly = true
      }
    }
  }
  out.days = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day))
  out.errors = out.errors.slice(0, 10)
  return out
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)
