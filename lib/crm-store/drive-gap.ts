/**
 * Drive-vs-storage gap check (dev job ad09ea91; Antonio 2026-10-16: "now that storage is live, check how many new files are missing in
 * our storage from the old Drive"). READ-ONLY: it lists a company's old Drive folder and says, for each file, whether storage already has
 * it. It never writes to Drive and never changes storage or any CRM record.
 *
 * Why it is needed: the catch-up only sees files the CRM has a record for. A file put straight into Drive (by hand, or by an outside
 * tool such as the Google Drive connector) has no CRM record, so nothing else can ever notice it.
 */
import { storeNameKey } from "./rules"
import { supabaseAdmin } from "@/lib/supabase-admin"

export type GapKind =
  | "imported"            // storage already holds it (the move recorded this exact Drive file)
  | "same_content_seen"   // a move saw a file with exactly these bytes (a duplicate copy in Drive) — already decided
  | "in_crm_on_drive"     // the CRM lists it but still points at Drive (the catch-up can bring it in)
  | "same_name_stored"    // not recorded, but storage has a file of the same name — probably already there (renamed / re-uploaded)
  | "google_native"       // a Google Doc / Sheet / Slide — a link, not a file; never moved
  | "missing"             // nothing in storage or the CRM matches it

export interface GapFile {
  id: string
  name: string
  mimeType: string
  path: string[]
  size: number | null
  /** Drive's md5 of the bytes (null for Google-native files) */
  md5?: string | null
}

export interface GapContext {
  /** Drive file ids the move recorded as imported */
  importedIds: ReadonlySet<string>
  /** md5 of every Drive file a move saw — a Drive file with the same bytes is a duplicate copy of something already decided */
  seenMd5?: ReadonlySet<string>
  /** Drive file ids a CRM documents row still points at */
  crmDriveIds: ReadonlySet<string>
  /** name keys of the files this company's storage holds (live) */
  storedNameKeys: ReadonlySet<string>
}

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps."

export function classifyGapFile(f: GapFile, ctx: GapContext): GapKind {
  if (ctx.importedIds.has(f.id)) return "imported"
  if (f.md5 && ctx.seenMd5?.has(f.md5)) return "same_content_seen"
  if (f.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) return "google_native"
  if (ctx.crmDriveIds.has(f.id)) return "in_crm_on_drive"
  if (ctx.storedNameKeys.has(storeNameKey(f.name))) return "same_name_stored"
  return "missing"
}

export interface GapReport {
  accountId: string
  company: string
  driveFolderId: string
  total: number
  counts: Record<GapKind, number>
  /** only the files that need a look: missing, in_crm_on_drive, same_name_stored */
  files: Array<{ id: string; name: string; path: string; kind: GapKind; size: number | null }>
}

export function summarizeGap(meta: { accountId: string; company: string; driveFolderId: string }, files: GapFile[], ctx: GapContext): GapReport {
  const counts: Record<GapKind, number> = { imported: 0, same_content_seen: 0, in_crm_on_drive: 0, same_name_stored: 0, google_native: 0, missing: 0 }
  const out: GapReport["files"] = []
  for (const f of files) {
    const kind = classifyGapFile(f, ctx)
    counts[kind]++
    if (kind === "missing" || kind === "in_crm_on_drive" || kind === "same_name_stored") out.push({ id: f.id, name: f.name, path: f.path.join(" › "), kind, size: f.size })
  }
  return { ...meta, total: files.length, counts, files: out }
}

export interface GapCompany { accountId: string; company: string; driveFolderId: string; ownerId: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

/** Companies in live storage that still have an old Drive folder to compare. */
export async function listGapCompanies(): Promise<GapCompany[]> {
  const d = db()
  const { data: owners, error } = await d.from("store_owners").select("id, account_id").eq("kind", "company").eq("study_only", false).not("account_id", "is", null)
  if (error) throw new Error("Could not read the companies in storage.")
  const ids = ((owners ?? []) as Array<{ id: string; account_id: string }>)
  const out: GapCompany[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data: accts, error: aErr } = await d.from("accounts").select("id, company_name, drive_folder_id").in("id", chunk.map((o) => o.account_id))
    if (aErr) throw new Error("Could not read the companies.")
    for (const a of (accts ?? []) as Array<{ id: string; company_name: string | null; drive_folder_id: string | null }>) {
      if (!a.drive_folder_id) continue
      const o = chunk.find((x) => x.account_id === a.id)
      if (o) out.push({ accountId: a.id, company: a.company_name ?? a.id, driveFolderId: a.drive_folder_id, ownerId: o.id })
    }
  }
  return out.sort((x, y) => x.company.localeCompare(y.company))
}

/** One company: read its Drive folder (read-only) and compare with storage. */
export async function scanCompanyGap(accountId: string): Promise<GapReport> {
  const d = db()
  const all = await listGapCompanies()
  const c = all.find((x) => x.accountId === accountId)
  if (!c) throw new Error("This company is not in storage, or has no Drive folder.")
  const { scanDrive } = await import("./drive-import")
  const scanned = await scanDrive(c.driveFolderId)
  const files: GapFile[] = scanned.map((s) => ({ id: s.source_id, name: s.name, mimeType: s.mime_type ?? "", path: s.drive_path ?? [], size: s.size_bytes ?? null, md5: s.source_md5 ?? null }))

  const importedIds = new Set<string>()
  const crmDriveIds = new Set<string>()
  const ids = files.map((f) => f.id)
  // every Drive file the company's move scans ever listed was DECIDED then (brought in, merged, archived or deliberately left):
  // only a file no scan has seen is new
  const { data: runs, error: runErr } = await d.from("store_import_runs").select("id").eq("account_id", accountId)
  if (runErr) throw new Error("Could not read the company's moves.")
  const runIds = ((runs ?? []) as Array<{ id: string }>).map((r) => r.id)
  for (let i = 0; i < ids.length && runIds.length; i += 150) {
    const chunk = ids.slice(i, i + 150)
    const { data: seen, error: seenErr } = await d.from("store_import_items").select("source_id").eq("source", "drive").in("run_id", runIds).in("source_id", chunk)
    if (seenErr) throw new Error("Could not read what the moves saw.")
    for (const r of (seen ?? []) as Array<{ source_id: string }>) importedIds.add(r.source_id)
  }
  const seenMd5 = new Set<string>()
  for (let from = 0; runIds.length; from += 1000) {
    const { data: m, error: mErr } = await d.from("store_import_items").select("source_md5").eq("source", "drive").in("run_id", runIds).not("source_md5", "is", null).range(from, from + 999)
    if (mErr) throw new Error("Could not read what the moves saw.")
    for (const r of (m ?? []) as Array<{ source_md5: string }>) seenMd5.add(r.source_md5)
    if (!m || m.length < 1000) break
  }
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150)
    const { data: refs, error } = await d.from("store_external_refs").select("external_id").eq("provider", "gdrive").eq("direction", "import").in("external_id", chunk)
    if (error) throw new Error("Could not read what was imported.")
    for (const r of (refs ?? []) as Array<{ external_id: string }>) importedIds.add(r.external_id)
    const { data: docs, error: dErr } = await d.from("documents").select("drive_file_id").eq("account_id", accountId).in("drive_file_id", chunk)
    if (dErr) throw new Error("Could not read the CRM documents.")
    for (const r of (docs ?? []) as Array<{ drive_file_id: string }>) crmDriveIds.add(r.drive_file_id)
  }
  const storedNameKeys = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data: sf, error } = await d.from("store_files").select("name_key").eq("owner_id", c.ownerId).eq("state", "live").range(from, from + 999)
    if (error) throw new Error("Could not read the files in storage.")
    for (const r of (sf ?? []) as Array<{ name_key: string | null }>) if (r.name_key) storedNameKeys.add(r.name_key)
    if (!sf || sf.length < 1000) break
  }
  return summarizeGap({ accountId, company: c.company, driveFolderId: c.driveFolderId }, files, { importedIds, seenMd5, crmDriveIds, storedNameKeys })
}
