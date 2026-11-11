/**
 * Filing Zoom call folders into TD Zoom Calls › year › month (dev job 1f4645b6, 2026-11-11). The rules are in `zoom-call-filing-rules.ts` (pure, tested);
 * this file holds the RUNNER (`fileZoomCalls`, every outside step goes through `FilingDeps`, so it is tested with fakes) and the REAL services (`liveFilingDeps`).
 *
 * A call recorded on Antonio's Mac arrives as a folder named by Zoom at the top of Business › Zoom Calls. Once nothing in it has changed for 10 minutes and no
 * upload is open, the folder is moved into TD Zoom Calls (or TD Marketing Calls when it is a call booked with the marketing booking link) and TD Zoom Calls'
 * saved "Sort by date" choice is applied, so it lands in e.g. 2026 › 11 November. Only folders are moved — nothing is renamed, deleted or overwritten.
 *
 * The switch is `app_settings.zoom_call_filing` = {"mode":"off" | "dry_run" | "live"}. Missing / malformed = off. Claude flips it (never a button for Antonio).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  MAX_PER_RUN, decide, isCallFolderName, isQuiet, orderForRun, originText,
  type Booking, type CandidateFolder, type Destination, type Origin,
} from "./zoom-call-filing-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until production
const db = () => supabaseAdmin as any

export type FilingMode = "off" | "dry_run" | "live"
export const SETTING_KEY = "zoom_call_filing"
/** At most this many "Sort by date" calls (15 items each) after a run's moves. */
const MAX_SORT_ROUNDS = 6

export function parseMode(raw: unknown): FilingMode {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).mode : raw
  return v === "live" || v === "dry_run" ? v : "off"
}

export interface Areas { ownerId: string; zoomCalls: string; tdZoom: string; tdMarketing: string | null }

export interface FilingDeps {
  now: () => Date
  mode: () => Promise<FilingMode>
  areas: () => Promise<{ ok: true; areas: Areas } | { ok: false; reason: string }>
  candidates: (zoomCallsId: string) => Promise<CandidateFolder[]>
  /** The same folder read again right before it is moved (null = no longer at the top of Zoom Calls). */
  recheck: (folderId: string) => Promise<CandidateFolder | null>
  bookings: (candidates: readonly CandidateFolder[]) => Promise<Booking[]>
  move: (folderId: string, toParentId: string) => Promise<void>
  sortTdZoom: (tdZoomId: string) => Promise<{ moved: number; failed: number; remaining: number }>
  record: (e: { areas: Areas; folder: CandidateFolder; destination: Destination; origin: Origin; booking: Booking | null; matchedOn: string | null; text: string }) => Promise<void>
}

export interface FilingReport {
  mode: FilingMode
  /** Why nothing ran at all (switched off, a folder is missing). */
  skipped?: string
  seen: number
  waiting: Array<{ name: string; reason: string }>
  filed: Array<{ name: string; destination: Destination; origin: Origin; text: string; dryRun: boolean }>
  deferred: number
  failed: Array<{ name: string; error: string }>
  sort?: { moved: number; failed: number; remaining: number }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function fileZoomCalls(d: FilingDeps): Promise<FilingReport> {
  const mode = await d.mode()
  const report: FilingReport = { mode, seen: 0, waiting: [], filed: [], deferred: 0, failed: [] }
  if (mode === "off") return { ...report, skipped: "The filing job is switched off." }
  const a = await d.areas()
  if (a.ok === false) return { ...report, skipped: a.reason }
  const areas = a.areas

  const candidates = (await d.candidates(areas.zoomCalls)).filter(c => isCallFolderName(c.name))
  report.seen = candidates.length
  if (candidates.length === 0) return report

  const now = d.now()
  // The bookings are only read when at least one folder is old enough to be filed.
  const quiet = candidates.filter(c => !c.uploadOpen && isQuiet(c, now))
  const bookings = quiet.length > 0 ? await d.bookings(quiet) : []

  let planned = 0
  let movedToTdZoom = false
  for (const c of orderForRun(candidates)) {
    const dec = decide(c, now, bookings)
    if (dec.action === "skip") continue
    if (dec.action === "wait") { report.waiting.push({ name: c.name, reason: dec.reason }); continue }
    if (planned >= MAX_PER_RUN) { report.deferred++; continue }
    const destId = dec.destination === "td_marketing" ? areas.tdMarketing : areas.tdZoom
    if (!destId) { report.waiting.push({ name: c.name, reason: "no_marketing_folder" }); continue }
    const text = originText(dec.origin, dec.booking)

    if (mode === "dry_run") {
      report.filed.push({ name: c.name, destination: dec.destination, origin: dec.origin, text, dryRun: true })
      planned++
      continue
    }

    // live: look at the folder once more right before moving it (a late file may have arrived since the first look)
    let fresh: CandidateFolder | null
    try { fresh = await d.recheck(c.id) } catch (e) { report.failed.push({ name: c.name, error: msg(e) }); continue }
    if (!fresh) { report.waiting.push({ name: c.name, reason: "no_longer_there" }); continue }
    if (decide(fresh, d.now(), bookings).action !== "file") { report.waiting.push({ name: c.name, reason: "still_changing" }); continue }

    try { await d.move(c.id, destId) } catch (e) { report.failed.push({ name: c.name, error: msg(e) }); continue }
    planned++
    report.filed.push({ name: c.name, destination: dec.destination, origin: dec.origin, text, dryRun: false })
    if (dec.destination === "td_zoom") movedToTdZoom = true
    // the move is done; a failed log line must not undo or hide it
    await d.record({ areas, folder: c, destination: dec.destination, origin: dec.origin, booking: dec.booking, matchedOn: dec.matchedOn, text }).catch(e => report.failed.push({ name: `${c.name} (activity log)`, error: msg(e) }))
  }

  if (movedToTdZoom) {
    try {
      const total = { moved: 0, failed: 0, remaining: 0 }
      for (let round = 0; round < MAX_SORT_ROUNDS; round++) {
        const r = await d.sortTdZoom(areas.tdZoom)
        total.moved += r.moved; total.failed += r.failed; total.remaining = r.remaining
        if (r.remaining === 0 || r.moved === 0) break
      }
      report.sort = total
      if (total.failed > 0) report.failed.push({ name: "Sort by date", error: `${total.failed} item(s) could not be sorted into the year / month folders.` })
    } catch (e) { report.failed.push({ name: "Sort by date", error: msg(e) }) }
  }
  return report
}

// ───────────────────────────────────────────────────────────── the real services

const TD_ZOOM_NAME = /^td\s*zoom\s*calls$/i
/** The same loose check the Zoom cloud-recording job uses for the marketing folder (his spelling today has a typo). */
const MARKETING_NAME = /market|marek/i
const iso = (v: unknown): number => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isNaN(t) ? 0 : t }

/** `opts.zoomCallsId` lets the sandbox proof script point the job at its OWN test tree; `opts.mode` and `opts.now` let a test fix the switch and the clock. */
export function liveFilingDeps(opts: { now?: () => Date; zoomCallsId?: string; mode?: FilingMode } = {}): FilingDeps {
  const now = opts.now ?? (() => new Date())
  let zoomCallsInUse: string | null = null

  async function activityOf(folder: { id: string; created_at: string; updated_at: string | null }): Promise<{ lastActivity: Date; uploadOpen: boolean }> {
    let last = Math.max(iso(folder.created_at), iso(folder.updated_at))
    const ids = [folder.id]
    let frontier = [folder.id]
    for (let depth = 0; depth < 4 && frontier.length > 0 && ids.length < 200; depth++) {
      const { data, error } = await db().from("store_folders").select("id, created_at, updated_at").in("parent_id", frontier)
      if (error) throw new Error(`Could not read the call folder (${error.message}).`)
      frontier = []
      for (const k of (data ?? []) as Array<{ id: string; created_at: string; updated_at: string | null }>) { ids.push(k.id); frontier.push(k.id); last = Math.max(last, iso(k.created_at), iso(k.updated_at)) }
    }
    const fileIds: string[] = []
    for (let from = 0; from < ids.length; from += 100) {
      const { data, error } = await db().from("store_files").select("id, created_at, updated_at, trashed_at").in("folder_id", ids.slice(from, from + 100))
      if (error) throw new Error(`Could not read the call folder's files (${error.message}).`)
      for (const f of (data ?? []) as Array<{ id: string; created_at: string; updated_at: string | null; trashed_at: string | null }>) { fileIds.push(f.id); last = Math.max(last, iso(f.created_at), iso(f.updated_at), iso(f.trashed_at)) }
    }
    // a file that keeps growing gets new VERSIONS while its own row stays unchanged — that is the real "still being written" signal
    for (let from = 0; from < fileIds.length; from += 100) {
      const { data, error } = await db().from("store_file_versions").select("created_at").in("file_id", fileIds.slice(from, from + 100)).order("created_at", { ascending: false }).limit(1)
      if (error) throw new Error(`Could not read the call folder's versions (${error.message}).`)
      last = Math.max(last, iso(data?.[0]?.created_at))
    }
    let uploadOpen = false
    for (let from = 0; from < ids.length && !uploadOpen; from += 100) {
      const { data, error } = await db().from("store_upload_intents").select("id").in("folder_id", ids.slice(from, from + 100)).is("consumed_at", null).gt("expires_at", now().toISOString()).limit(1)
      if (error) throw new Error(`Could not read the call folder's uploads (${error.message}).`)
      uploadOpen = (data?.length ?? 0) > 0
    }
    return { lastActivity: new Date(last), uploadOpen }
  }

  async function candidateFrom(row: { id: string; name: string; created_at: string; updated_at: string | null }): Promise<CandidateFolder> {
    const act = await activityOf(row)
    return { id: row.id, name: row.name, createdAt: new Date(row.created_at), lastActivity: act.lastActivity, uploadOpen: act.uploadOpen }
  }

  return {
    now,
    mode: async () => {
      if (opts.mode) return opts.mode
      try {
        const { data, error } = await db().from("app_settings").select("value").eq("key", SETTING_KEY).maybeSingle()
        return error ? "off" : parseMode(data?.value)
      } catch { return "off" }
    },

    areas: async () => {
      let ownerId: string
      let zoomCalls: string
      if (opts.zoomCallsId) {
        const { data } = await db().from("store_folders").select("id, owner_id").eq("id", opts.zoomCallsId).is("trashed_at", null).maybeSingle()
        if (!data) return { ok: false as const, reason: "The test Zoom Calls folder was not found." }
        ownerId = data.owner_id as string; zoomCalls = data.id as string
      } else {
        const { data: o } = await db().from("store_owners").select("id").eq("kind", "business").limit(1)
        if (!o?.[0]) return { ok: false as const, reason: "There is no Business storage." }
        ownerId = o[0].id as string
        const { data: top } = await db().from("store_folders").select("id").eq("owner_id", ownerId).is("parent_id", null).is("trashed_at", null).limit(1)
        if (!top?.[0]) return { ok: false as const, reason: "The Business storage has no top folder." }
        const { data: zc } = await db().from("store_folders").select("id").eq("parent_id", top[0].id).ilike("name", "Zoom Calls").is("trashed_at", null).limit(2)
        if (!zc || zc.length !== 1) return { ok: false as const, reason: zc?.length ? 'More than one "Zoom Calls" folder is in Business.' : 'There is no "Zoom Calls" folder in Business.' }
        zoomCalls = zc[0].id as string
      }
      const { data: kids } = await db().from("store_folders").select("id, name").eq("parent_id", zoomCalls).is("trashed_at", null)
      // a call folder is never one of the two destination folders, even when its title says "marketing" (found by the sandbox proof script)
      const list = ((kids ?? []) as Array<{ id: string; name: string }>).filter(k => !isCallFolderName(k.name))
      const td = list.filter(k => TD_ZOOM_NAME.test(k.name.trim()))
      if (td.length !== 1) return { ok: false as const, reason: td.length === 0 ? 'There is no "TD Zoom Calls" folder inside Zoom Calls.' : 'More than one "TD Zoom Calls" folder is inside Zoom Calls.' }
      const mk = list.filter(k => MARKETING_NAME.test(k.name))
      zoomCallsInUse = zoomCalls
      return { ok: true as const, areas: { ownerId, zoomCalls, tdZoom: td[0].id, tdMarketing: mk.length === 1 ? mk[0].id : null } }
    },

    candidates: async (zoomCallsId) => {
      const { data, error } = await db().from("store_folders").select("id, name, created_at, updated_at").eq("parent_id", zoomCallsId).eq("kind", "custom").is("trashed_at", null).order("created_at").limit(200)
      if (error) throw new Error(`Could not read Zoom Calls (${error.message}).`)
      const out: CandidateFolder[] = []
      for (const row of (data ?? []) as Array<{ id: string; name: string; created_at: string; updated_at: string | null }>) {
        if (isCallFolderName(row.name)) out.push(await candidateFrom(row))
      }
      return out
    },

    recheck: async (folderId) => {
      const { data, error } = await db().from("store_folders").select("id, name, parent_id, created_at, updated_at, trashed_at").eq("id", folderId).maybeSingle()
      if (error) throw new Error(`Could not read the call folder (${error.message}).`)
      if (!data || data.trashed_at || data.parent_id !== zoomCallsInUse) return null
      return candidateFrom(data)
    },

    bookings: async (cands) => {
      const { callStartFromName } = await import("./zoom-call-filing-rules")
      const times = cands.flatMap(c => [c.createdAt.getTime(), callStartFromName(c.name)?.getTime() ?? c.createdAt.getTime()])
      const from = new Date(Math.min(...times) - 24 * 3_600_000).toISOString()
      const to = new Date(Math.max(...times) + 24 * 3_600_000).toISOString()
      const out: Booking[] = []

      const calls = await db().from("lead_calls").select("lead_id, scheduled_start").in("state", ["scheduled", "done"]).not("scheduled_start", "is", null).gte("scheduled_start", from).lte("scheduled_start", to)
      if (calls.error) throw new Error(`Could not read the Calendly bookings (${calls.error.message}).`)
      const rows = (calls.data ?? []) as Array<{ lead_id: string; scheduled_start: string }>
      const names = new Map<string, string>()
      const leadIds = Array.from(new Set(rows.map(r => r.lead_id)))
      for (let i = 0; i < leadIds.length; i += 100) {
        const { data } = await db().from("leads").select("id, full_name, first_name, last_name").in("id", leadIds.slice(i, i + 100))
        for (const l of (data ?? []) as Array<{ id: string; full_name: string | null; first_name: string | null; last_name: string | null }>) {
          names.set(l.id, (l.full_name ?? `${l.first_name ?? ""} ${l.last_name ?? ""}`).trim())
        }
      }
      for (const r of rows) out.push({ kind: "calendly", start: new Date(r.scheduled_start), end: null, who: names.get(r.lead_id) || null })

      const links = await db().from("marketing_joint_links").select("client_name, starts_at, ends_at").is("cancelled_at", null).is("revoked_at", null).not("booked_at", "is", null).not("starts_at", "is", null).gte("starts_at", from).lte("starts_at", to)
      if (links.error) throw new Error(`Could not read the marketing bookings (${links.error.message}).`)
      for (const l of (links.data ?? []) as Array<{ client_name: string | null; starts_at: string; ends_at: string | null }>) {
        out.push({ kind: "marketing", start: new Date(l.starts_at), end: l.ends_at ? new Date(l.ends_at) : null, who: l.client_name })
      }
      return out
    },

    move: async (folderId, toParentId) => {
      const { moveFolder } = await import("./structure")
      await moveFolder(folderId, toParentId, null)
    },

    sortTdZoom: async (tdZoomId) => {
      const { applyDateSort, savedSettings, DEFAULT_DATE_SORT } = await import("./date-sort")
      const settings = (await savedSettings(tdZoomId)) ?? DEFAULT_DATE_SORT
      const r = await applyDateSort(tdZoomId, settings, null)
      return { moved: r.moved, failed: r.failed.length, remaining: r.remaining }
    },

    record: async e => {
      const { logStoreEvent } = await import("./event-log")
      await logStoreEvent({
        event: "zoom_call_filed", actor: null, owner_id: e.areas.ownerId, folder_id: e.folder.id, name_snapshot: e.folder.name, reason: e.text,
        details: {
          origin: e.origin, destination: e.destination, matched_on: e.matchedOn,
          booking: e.booking ? { kind: e.booking.kind, start: e.booking.start.toISOString(), end: e.booking.end ? e.booking.end.toISOString() : null, who: e.booking.who } : null,
        },
      })
    },
  }
}
