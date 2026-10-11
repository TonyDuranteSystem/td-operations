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
  }
}

// ─── Live dependencies ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = async () => (await import("@/lib/supabase-admin")).supabaseAdmin as any

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
  const { data: owners, error } = await d.from("store_owners").select("account_id, contact_id, kind, service_delivery_id, study_only")
  if (error) throw new Error(`store guard: could not read the storage owners — ${error.message}`)
  const { data: runs, error: rErr } = await d.from("store_import_runs").select("account_id").in("status", ["scanning", "moving", "undoing"]).eq("mode", "move")
  if (rErr) throw new Error(`store guard: could not read the move runs — ${rErr.message}`)

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
  for (const part of chunks(Array.from(accountIds))) {
    const { data, error: aErr } = await d.from("accounts").select("drive_folder_id").in("id", part)
    if (aErr) throw new Error(`store guard: could not read the company folders — ${aErr.message}`)
    for (const a of (data ?? []) as Array<{ drive_folder_id: string | null }>) if (a.drive_folder_id) folders.add(a.drive_folder_id)
  }
  for (const part of chunks(Array.from(contactIds))) {
    const { data, error: cErr } = await d.from("contacts").select("drive_folder_id").in("id", part)
    if (cErr) throw new Error(`store guard: could not read the person folders — ${cErr.message}`)
    for (const c of (data ?? []) as Array<{ drive_folder_id: string | null }>) if (c.drive_folder_id) folders.add(c.drive_folder_id)
  }
  return folders
}

let lockedCache: { at: number; ids: Set<string> } | null = null
const LOCKED_TTL_MS = 15_000

/** Cached for a few seconds (every Drive write asks); a failed read is never cached and always refuses. */
export async function lockedFolderIdsCached(now: number = Date.now()): Promise<Set<string>> {
  if (lockedCache && now - lockedCache.at < LOCKED_TTL_MS) return lockedCache.ids
  const ids = await readLockedFolderIds()
  lockedCache = { at: now, ids }
  return ids
}

/** Tests / the switch itself: forget the cached answer so the next write sees the new state at once. */
export function forgetLockedFolderCache(): void {
  lockedCache = null
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
