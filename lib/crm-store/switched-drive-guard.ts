/**
 * CRM Store — the cutover safety layer, part 1: a company whose documents live in the new storage
 * (or are being moved there) can NEVER be written to in Google Drive (dev job ad09ea91; plan Part 32).
 *
 * Antonio 2026-10-10: "when we wire the storage, we must use only the storage and not Drive." A gateway
 * that callers are asked to use is advisory; this check is mandatory — it sits inside `guardDriveWrite`
 * (lib/google-drive.ts), the one place every Drive write already passes. A code path nobody remembered
 * fails LOUDLY instead of splitting a company across two stores.
 *
 * Three states per company (decision of the plan, one function, `companyDocState`):
 *   drive   — files live in Drive (today: every company). Nothing is refused.
 *   moving  — a real "move" run is in progress: new writes are refused (never routed, never queued
 *             silently) so nothing lands in Drive after the scan has already been taken.
 *   store   — the company (or its person) has a live (not study-only) storage: Drive is read-only.
 * A study copy is NOT a state: it is a hidden copy of a company that still lives in Drive.
 *
 * Fails CLOSED: if the lookup cannot be read while storage companies exist, the write is refused.
 * The only way through is `runAsStoreBackup`, used by the one-way backup (storage → Drive) and nothing else.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export type CompanyDocState = "drive" | "moving" | "store"

export class SwitchedCompanyDriveWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SwitchedCompanyDriveWriteError"
  }
}

/** Pure: the state from the three facts. A live storage wins over an open move. */
export function stateFrom(f: { hasLiveOwner: boolean; hasLiveFormationOwner?: boolean; openMoveRun: boolean }): CompanyDocState {
  if (f.hasLiveOwner || f.hasLiveFormationOwner) return "store"
  if (f.openMoveRun) return "moving"
  return "drive"
}

const backupScope = new AsyncLocalStorage<boolean>()

/** The ONE exception: the one-way backup writes a switched company's files INTO its Drive folder (Antonio: backup kept). */
export function runAsStoreBackup<T>(fn: () => Promise<T>): Promise<T> {
  return backupScope.run(true, fn)
}

export interface GuardDeps {
  /** Drive folder ids of every company / person that is in state `moving` or `store`. Throws when unreadable. */
  lockedFolderIds: () => Promise<Set<string>>
  /** Parent folder ids of a Drive file or folder ([] at the root). */
  parentsOf: (id: string) => Promise<string[]>
}

const MAX_DEPTH = 12

/** Pure core (dependencies injected): throws when any target is, or sits inside, a locked company folder. */
export async function assertTargetsNotSwitched(ids: string[], deps: GuardDeps): Promise<void> {
  if (backupScope.getStore()) return
  const targets = ids.filter(Boolean)
  if (targets.length === 0) return
  const locked = await deps.lockedFolderIds()
  if (locked.size === 0) return // nothing switched yet: no lookups, no Drive calls
  for (const id of targets) {
    let frontier = [id]
    const seen = new Set<string>()
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const cur of frontier) {
        if (seen.has(cur)) continue
        seen.add(cur)
        if (locked.has(cur)) {
          throw new SwitchedCompanyDriveWriteError(
            "This company's files live in the new CRM storage — nothing may be written to its Google Drive folder. Save the file through the storage instead.",
          )
        }
        next.push(...(await deps.parentsOf(cur)))
      }
      frontier = next
    }
    // Still climbing after the depth limit: the lineage is deeper than we can prove safe — refuse (fail closed).
    if (frontier.length > 0) throw new SwitchedCompanyDriveWriteError("Could not verify where this Drive folder sits (it is nested too deeply) — the write was refused.")
  }
}

// ─── Live dependencies ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = async () => (await import("@/lib/supabase-admin")).supabaseAdmin as any

const PAGE = 1000
async function readAllPages<T>(what: string, page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(`store guard: could not read the ${what} — ${error.message}`)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE) return all
  }
}

/** Ids go in the URL of a database request: a long list must be sent in small batches or the request fails. */
const CHUNK = 100
function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

/** One read of the live state for every company/person; strict (throws on any read error). */
export async function readLockedFolderIds(): Promise<Set<string>> {
  const d = await db()
  // Only the LIVE owners matter (study copies are not a state), and every page is read: the database sends at most
  // 1,000 rows per request, and a row silently left unread would be a switched company left unprotected.
  const owners = await readAllPages("storage owners", (from, to) =>
    d.from("store_owners").select("account_id, contact_id, kind, service_delivery_id, study_only").eq("study_only", false).order("id").range(from, to))
  const runs = await readAllPages("move runs", (from, to) =>
    d.from("store_import_runs").select("account_id").in("status", ["scanning", "moving", "undoing"]).eq("mode", "move").order("id").range(from, to))

  const accountIds = new Set<string>()
  const contactIds = new Set<string>()
  const formationSds: string[] = []
  for (const o of (owners ?? []) as Array<{ account_id: string | null; contact_id: string | null; kind: string; service_delivery_id: string | null; study_only: boolean | null }>) {
    if (o.study_only) continue
    if (o.account_id) accountIds.add(o.account_id)
    if (o.contact_id) contactIds.add(o.contact_id)
    if (o.kind === "formation" && o.service_delivery_id) formationSds.push(o.service_delivery_id)
  }
  for (const r of (runs ?? []) as Array<{ account_id: string | null }>) if (r.account_id) accountIds.add(r.account_id)
  for (const part of chunks(formationSds)) {
    const { data: sds, error: sErr } = await d.from("service_deliveries").select("account_id").in("id", part)
    if (sErr) throw new Error(`store guard: could not read the formation cases — ${sErr.message}`)
    for (const s of (sds ?? []) as Array<{ account_id: string | null }>) if (s.account_id) accountIds.add(s.account_id)
  }

  const folders = new Set<string>()
  // A folder id is on the record in two forms: `drive_folder_id`, or only inside the older `gdrive_folder_url` link.
  const folderIdsOf = (r: { drive_folder_id?: string | null; gdrive_folder_url?: string | null }): string[] => {
    const out: string[] = []
    if (r.drive_folder_id) out.push(r.drive_folder_id)
    const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(r.gdrive_folder_url ?? "")
    if (m) out.push(m[1])
    return out
  }
  for (const part of chunks(Array.from(accountIds))) {
    const { data, error: aErr } = await d.from("accounts").select("drive_folder_id, gdrive_folder_url").in("id", part)
    if (aErr) throw new Error(`store guard: could not read the company folders — ${aErr.message}`)
    for (const a of (data ?? []) as Array<{ drive_folder_id: string | null; gdrive_folder_url: string | null }>) for (const f of folderIdsOf(a)) folders.add(f)
  }
  const personFolders = new Set<string>()
  for (const part of chunks(Array.from(contactIds))) {
    const { data, error: cErr } = await d.from("contacts").select("drive_folder_id, gdrive_folder_url").in("id", part)
    if (cErr) throw new Error(`store guard: could not read the person folders — ${cErr.message}`)
    for (const c of (data ?? []) as Array<{ drive_folder_id: string | null; gdrive_folder_url: string | null }>) for (const f of folderIdsOf(c)) personFolders.add(f)
  }
  // A person's folder can be one folder shared with other people (a company's "2. Contacts"): locking it would also stop
  // people who are still on Drive. Only a folder that belongs to that person alone is locked (the move itself refuses a shared one).
  const shared = new Set<string>()
  for (const part of chunks(Array.from(personFolders))) {
    const { data, error: sErr } = await d.from("contacts").select("drive_folder_id").in("drive_folder_id", part)
    if (sErr) throw new Error(`store guard: could not read the shared person folders — ${sErr.message}`)
    const seen = new Map<string, number>()
    for (const c of (data ?? []) as Array<{ drive_folder_id: string | null }>) if (c.drive_folder_id) seen.set(c.drive_folder_id, (seen.get(c.drive_folder_id) ?? 0) + 1)
    seen.forEach((n, f) => { if (n > 1) shared.add(f) })
  }
  personFolders.forEach((f) => { if (!shared.has(f)) folders.add(f) })
  return folders
}

let lockedInFlight: Promise<Set<string>> | null = null

/**
 * No cache: a company that switches must be protected at once, on every server instance (a cached answer would
 * leave a window where another instance still writes to Drive). Concurrent calls share ONE read; the next call
 * after it finishes reads again. A failed read is never kept and always refuses the write.
 */
export function lockedFolderIdsCached(): Promise<Set<string>> {
  if (!lockedInFlight) {
    lockedInFlight = readLockedFolderIds().finally(() => { lockedInFlight = null })
  }
  return lockedInFlight
}

/** Kept for callers and tests: nothing is cached any more, so there is nothing to forget. */
export function forgetLockedFolderCache(): void {
  lockedInFlight = null
}

/** The strict state of ONE company, read live (used by writers that must route, and by the move itself). */
export async function companyDocState(accountId: string): Promise<CompanyDocState> {
  const d = await db()
  const { data: live, error } = await d.from("store_owners").select("id").eq("account_id", accountId).eq("study_only", false).limit(1)
  if (error) throw new Error("Could not check where this company's files live — please try again.")
  const { data: run, error: rErr } = await d.from("store_import_runs").select("id").eq("account_id", accountId).eq("mode", "move").in("status", ["scanning", "moving", "undoing"]).limit(1)
  if (rErr) throw new Error("Could not check where this company's files live — please try again.")
  let hasLiveFormationOwner = false
  const { data: sds, error: sErr } = await d.from("service_deliveries").select("id").eq("account_id", accountId)
  if (sErr) throw new Error("Could not check where this company's files live — please try again.")
  const sdIds = ((sds ?? []) as Array<{ id: string }>).map((x) => x.id)
  if (sdIds.length > 0) {
    const { data: fo, error: foErr } = await d.from("store_owners").select("id").eq("kind", "formation").eq("study_only", false).in("service_delivery_id", sdIds).limit(1)
    if (foErr) throw new Error("Could not check where this company's files live — please try again.")
    hasLiveFormationOwner = (fo ?? []).length > 0
  }
  return stateFrom({ hasLiveOwner: (live ?? []).length > 0, hasLiveFormationOwner, openMoveRun: (run ?? []).length > 0 })
}

/** The live (not study-only) storage of a company, any environment — null when it has none. Strict: a read error throws. */
export async function liveOwnerOfAccount(accountId: string): Promise<string | null> {
  const d = await db()
  const { data, error } = await d.from("store_owners").select("id").eq("account_id", accountId).eq("study_only", false).limit(1)
  if (error) throw new Error("Could not check where this company's files live — please try again.")
  return ((data ?? [])[0]?.id as string | undefined) ?? null
}
