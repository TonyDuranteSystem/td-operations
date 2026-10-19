/* eslint-disable no-console -- a proof script prints its results */
/**
 * Change Name, Track S1 — the READ-ONLY old-vs-new folder-lookup comparison across ALL storages.
 *
 * Compares what the code looked up BEFORE (a fixed folder kind / a year folder found "anywhere in the owner",
 * first row wins, no ORDER BY) with what it looks up NOW (lib/crm-store/folder-lookup.ts: only the top folder's
 * direct children). For every storage it runs every lookup the live code makes:
 *   - each fixed kind a caller asks for (formation-pilot.folderOfKind, set-type.folderOf, plan-build.folderOfKindIn,
 *     the drive-import / catch-up kind maps): company, contacts, tax, banking, correspondence, personal, itin, person_tax;
 *   - each year folder by name (set-type.folderOf with a year): tax_year / person_tax_year.
 * A lookup is IDENTICAL when the old rule had exactly one possible answer and the new rule gives that same one
 * (or both give none / the top folder). Anything else is reported: the old rule's answer depended on row order
 * (ambiguous) or differed.
 *
 * Run (sandbox DB only — it refuses the production database):
 *   npx tsx scripts/crm-store/compare-folder-lookup.ts
 *   npx tsx scripts/crm-store/compare-folder-lookup.ts --from-json folders.json   (rows exported by a read-only query)
 * Exit code 1 when any lookup differs.
 */
import { config } from "dotenv"
import { readFileSync } from "fs"
import { pickKindFolder, pickYearFolder, YEAR_PARENT_KIND, topFolder, type LookupFolder } from "../../lib/crm-store/folder-lookup"

/** Every fixed kind a caller can ask for (see the header). */
export const CALLER_KINDS = ["company", "contacts", "tax", "banking", "correspondence", "personal", "itin", "person_tax"] as const

/** The OLD folderOfKind: first row that has a parent, else the first row — in whatever order the database returned them. */
export function legacyPickKindFolder(rows: LookupFolder[], kind: string): string | null {
  const same = rows.filter((r) => r.kind === kind)
  return (same.find((r) => r.parent_id !== null) ?? same[0])?.id ?? null
}

/** The OLD set-type year lookup: first folder of that kind with a parent whose trimmed name is the year, anywhere in the owner. */
export function legacyPickYearFolder(rows: LookupFolder[], kind: string, year: number | string): string | null {
  return rows.filter((r) => r.kind === kind && r.parent_id !== null).find((r) => (r.name ?? "").trim() === String(year))?.id ?? null
}

export interface OwnerFolders { ownerId: string; rows: LookupFolder[] }
export interface Difference { ownerId: string; what: string; oldCandidates: string[]; now: string | null; why: string }
export interface Comparison { owners: number; lookups: number; identical: number; differences: Difference[] }

export function compareLookups(owners: OwnerFolders[]): Comparison {
  const out: Comparison = { owners: owners.length, lookups: 0, identical: 0, differences: [] }
  const settle = (ownerId: string, what: string, oldCandidates: string[], oldAnswer: string | null, now: string | null) => {
    out.lookups++
    // the old rule had ONE possible answer when it had at most one candidate; with several its answer depended on row order
    const oldOne = oldCandidates.length <= 1
    if (oldOne && oldAnswer === now) { out.identical++; return }
    out.differences.push({
      ownerId, what, oldCandidates, now,
      why: !oldOne ? `the old rule could pick any of ${oldCandidates.length} folders` : `old answer ${oldAnswer ?? "none"} but now ${now ?? "none"}`,
    })
  }
  for (const { ownerId, rows } of owners) {
    for (const kind of CALLER_KINDS) {
      const candidates = rows.filter((r) => r.kind === kind && r.parent_id !== null).map((r) => r.id)
      settle(ownerId, `kind:${kind}`, candidates, legacyPickKindFolder(rows, kind), pickKindFolder(rows, kind))
    }
    for (const yearKind of Object.keys(YEAR_PARENT_KIND)) {
      const names = Array.from(new Set(rows.filter((r) => r.kind === yearKind && r.parent_id !== null).map((r) => (r.name ?? "").trim())))
      for (const name of names) {
        const candidates = rows.filter((r) => r.kind === yearKind && r.parent_id !== null && (r.name ?? "").trim() === name).map((r) => r.id)
        settle(ownerId, `year:${yearKind}:${name}`, candidates, legacyPickYearFolder(rows, yearKind, name), pickYearFolder(rows, yearKind, name))
      }
    }
  }
  return out
}

/** Group a flat list of folder rows (with owner_id) into one entry per owner; an owner with no top folder is kept (it is a finding). */
export function groupByOwner(rows: Array<LookupFolder & { owner_id: string }>): OwnerFolders[] {
  const by = new Map<string, LookupFolder[]>()
  for (const r of rows) by.set(r.owner_id, [...(by.get(r.owner_id) ?? []), r])
  return Array.from(by.entries()).map(([ownerId, rs]) => ({ ownerId, rows: rs }))
}

async function loadFromDatabase(): Promise<Array<LookupFolder & { owner_id: string }>> {
  config({ path: ".env.local" })
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production — export the rows with a read-only query and use --from-json")
  const { supabaseAdmin } = await import("../../lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types
  const d = supabaseAdmin as any
  const all: Array<LookupFolder & { owner_id: string }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await d.from("store_folders").select("id, owner_id, parent_id, kind, name, created_at").is("trashed_at", null).order("owner_id").order("id").range(from, from + 999)
    if (error) throw new Error(error.message)
    all.push(...(data ?? []))
    if ((data ?? []).length < 1000) return all
  }
}

async function main() {
  const i = process.argv.indexOf("--from-json")
  const rows = i >= 0 ? (JSON.parse(readFileSync(process.argv[i + 1], "utf8")) as Array<LookupFolder & { owner_id: string }>) : await loadFromDatabase()
  const owners = groupByOwner(rows)
  const noTop = owners.filter((o) => !topFolder(o.rows)).length
  const r = compareLookups(owners)
  console.log(`owners compared: ${r.owners} (without a live top folder: ${noTop})`)
  console.log(`lookups compared: ${r.lookups}  identical: ${r.identical}  different or ambiguous: ${r.differences.length}`)
  for (const d of r.differences.slice(0, 50)) console.log(`  owner ${d.ownerId} ${d.what}: ${d.why}`)
  if (r.differences.length > 50) console.log(`  … and ${r.differences.length - 50} more`)
  process.exit(r.differences.length ? 1 : 0)
}

if ((process.argv[1] ?? "").endsWith("compare-folder-lookup.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2) })
