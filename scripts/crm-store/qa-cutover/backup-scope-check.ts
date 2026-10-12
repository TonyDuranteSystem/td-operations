/* eslint-disable no-console */
/**
 * Phase 4 (dev job ad09ea91): the backup's work list and completeness alarm must only cover storages that are really backed up
 * (live, not a hidden study copy, not the Business / private areas). SANDBOX only, direct database connection.
 * Run: npx tsx scripts/crm-store/qa-cutover/backup-scope-check.ts [--print-only]
 */
import { config } from "dotenv"
import { Client } from "pg"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const kinds = await q("select kind, study_only, count(*)::int n from store_owners group by 1,2 order by 1,2")
  console.log("      owners:", JSON.stringify(kinds))
  const due = await q("select owner_id, reason from store_backup_dirty_owners(interval '24 hours', 100000)")
  const owners = await q("select id, kind, study_only from store_owners where id = any($1)", [due.map((d) => d.owner_id)])
  check("B1 the work list holds no hidden study copy", owners.every((o) => o.study_only === false), `${owners.filter((o) => o.study_only).length} study copies listed`)
  check("B2 the work list holds no Business / private area", owners.every((o) => o.kind !== "business" && o.kind !== "private"), JSON.stringify(owners.filter((o) => ["business", "private"].includes(o.kind))))
  const liveWithFiles = await q("select count(*)::int n from store_owners o where not o.study_only and o.kind not in ('business','private') and exists (select 1 from store_files f where f.owner_id=o.id)")
  const idle = await q("select count(*)::int n from store_owners o where not o.study_only and o.kind not in ('business','private') and exists (select 1 from store_files f where f.owner_id=o.id) and exists (select 1 from store_backup_state s where s.owner_id=o.id and s.lease_until > now())")
  check("B3 every real storage with files is listed (none lost by the filter)", due.length + idle[0].n >= liveWithFiles[0].n, `listed ${due.length}, leased ${idle[0].n}, expected ${liveWithFiles[0].n}`)
  const gaps = await q("select kind, owner_id from store_backup_gaps(interval '6 hours', 100000)")
  const gapOwners = await q("select id, kind, study_only from store_owners where id = any($1)", [gaps.map((g) => g.owner_id)])
  check("B4 the alarm names no study copy / Business / private area", gapOwners.every((o) => !o.study_only && o.kind !== "business" && o.kind !== "private"), JSON.stringify(gapOwners.filter((o) => o.study_only || ["business", "private"].includes(o.kind)).slice(0, 3)))
  const counts = Object.fromEntries((await q("select kind, n::int from store_backup_gap_counts()")).map((r) => [r.kind, r.n]))
  const expectedMissing = await q("select count(*)::int n from store_files f where f.state='live' and f.current_version_id is not null and not store_backup_file_ok(f.id) and exists (select 1 from store_owners o where o.id=f.owner_id and not o.study_only and o.kind not in ('business','private'))")
  check("B5 the alarm's missing-file count equals the real storages' only", counts["missing_file"] === expectedMissing[0].n, `alarm ${counts["missing_file"]} vs real ${expectedMissing[0].n}`)
  console.log("      alarm counts:", JSON.stringify(counts))
  await db.end()
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
