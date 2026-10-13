/* eslint-disable no-console */
/**
 * Go-live CLEAN LISTING (dev job ad09ea91, master plan Part 33) — SANDBOX ONLY, direct library calls on a test company.
 * Dry run → switch → the CRM list under the company is exactly the stored files (clean labels, hidden, one record each; old records archived)
 * → undo puts EVERYTHING back byte for byte → a stored copy that is not the approved bytes stops the switch.
 * Run: STORE_GO_LIVE=1 npx tsx scripts/crm-store/qa-cutover/t16-go-live-roundtrip.ts "<test company name starts with>"
 */
import { config } from "dotenv"
import { Client } from "pg"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  if (process.env.STORE_GO_LIVE !== "1") throw new Error("set STORE_GO_LIVE=1")
  const name = process.argv[2]
  if (!name || !name.startsWith("ZZ")) throw new Error("pass a test company name (starts with ZZ)")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const acct = (await q("select id, company_name from accounts where company_name like $1 order by created_at desc limit 1", [`${name}%`]))[0]
  if (!acct) throw new Error("no such test company")
  console.log("company:", acct.company_name)
  // two extra OLD-style records: an old visible duplicate the cleaning did not keep (→ archived), and a brand-new one made after the copy (→ untouched)
  const stamp = Date.now()
  const oldDup = (await q(`insert into documents (drive_file_id, file_name, account_id, account_name, category_name, document_type_name, portal_visible, status, created_at) values ($1,'QA old duplicate.pdf',$2,$3,'Company','Receipt',true,'classified','2025-01-01T00:00:00Z') returning id`, [`qa-old-${stamp}`, acct.id, acct.company_name]))[0].id
  const newer = (await q(`insert into documents (drive_file_id, file_name, account_id, account_name, category_name, document_type_name, portal_visible, status, created_at) values ($1,'QA newer than the copy.pdf',$2,$3,'Company','Receipt',true,'classified', now()) returning id`, [`qa-new-${stamp}`, acct.id, acct.company_name]))[0].id
  try {
  const snapshot = async () => ({
    docs: await q("select * from documents where account_id=$1 or (account_id is null and contact_id in (select contact_id from account_contacts where account_id=$1)) order by id", [acct.id]),
    owner: await q("select id, study_only from store_owners where account_id=$1 and kind='company'", [acct.id]),
    people: await q("select o.id, o.study_only from store_owners o where o.kind='person' and o.contact_id in (select contact_id from account_contacts where account_id=$1) order by o.id", [acct.id]),
  })
  const before = await snapshot()
  const ownerId = before.owner[0].id as string

  const { planGoLive, runGoLive, undoGoLive } = await import("../../../lib/crm-store/go-live-run")
  const { companyDocState } = await import("../../../lib/crm-store/switched-drive-guard")
  const actor = (await q("select id from auth.users limit 1"))[0]?.id as string

  const plan = await planGoLive(acct.id)
  console.log("      plan:", JSON.stringify({ may: plan.mayGoLive, blockers: plan.blockers, listing: plan.listing }))
  console.log("      files:", plan.files.map((f) => `${f.name} [${f.type ?? "no type"}]${f.newRecord ? " (new)" : ""}`).join(" | ").slice(0, 700))
  console.log("      archived:", plan.archived.map((a) => a.name).join(" | ").slice(0, 300))
  check("1  dry run changed nothing", JSON.stringify(await snapshot()) === JSON.stringify(before))
  check("2  dry run says it may switch and lists stored files", plan.mayGoLive && plan.listing.storedFiles > 0, plan.blockers.join("; "))

  const res = await runGoLive(acct.id, actor, { expectedPlanHash: plan.planHash })
  console.log("      result:", res.ok, res.message)
  check("3  switch succeeded", res.ok, res.message)
  const mid = await snapshot()
  check("4  company is now live", mid.owner[0]?.study_only === false)
  check("5  the company reads as 'store'", (await companyDocState(acct.id)) === "store")

  // every stored file of this company (and its people) has exactly ONE record pointing at it
  const stored = await q("select f.id, f.name from store_files f where f.state='live' and f.id in (select store_file_id from store_import_items where run_id in (select id from store_import_runs where owner_id=$1 and mode='copy' and status='done') and store_file_id is not null)", [ownerId])
  const pointers = stored.map((s: { id: string }) => `store:${s.id}`)
  const counts = await q("select drive_file_id, count(*)::int n from documents where drive_file_id = any($1) group by 1", [pointers])
  check("6  every stored file has exactly one record", stored.length > 0 && stored.every((s: { id: string }) => counts.find((c: { drive_file_id: string; n: number }) => c.drive_file_id === `store:${s.id}`)?.n === 1), `${stored.length} files, ${counts.length} listed`)
  const rows = await q("select d.file_name, d.portal_visible, d.status, d.drive_file_id from documents d where d.drive_file_id = any($1)", [pointers])
  check("7  the records carry the storage's clean names", stored.every((s: { id: string; name: string }) => rows.find((r: { drive_file_id: string; file_name: string }) => r.drive_file_id === `store:${s.id}`)?.file_name === s.name))
  check("8  nothing from storage is shown to the client yet", rows.every((r: { portal_visible: boolean }) => r.portal_visible === false))
  const archived = await q("select count(*)::int n from documents where status='archived' and (account_id=$1 or contact_id in (select contact_id from account_contacts where account_id=$1))", [acct.id])
  check("9  the old records the cleaning did not keep are archived", archived[0].n === plan.listing.archivedRecords, `${archived[0].n} vs ${plan.listing.archivedRecords}`)
  const oldRow = (await q("select status, portal_visible from documents where id=$1", [oldDup]))[0]
  check("9b the old duplicate is archived and hidden, kept for staff", oldRow.status === "archived" && oldRow.portal_visible === false, JSON.stringify(oldRow))
  const newRow = (await q("select status, portal_visible, drive_file_id from documents where id=$1", [newer]))[0]
  check("9c a record made after the copy is left exactly as it is", newRow.status === "classified" && newRow.portal_visible === true && newRow.drive_file_id === `qa-new-${stamp}`, JSON.stringify(newRow))
  check("10 a member whose only company is this one went live with it", mid.people.every((p: { study_only: boolean }) => p.study_only === false), JSON.stringify(mid.people))
  const second = await runGoLive(acct.id, actor)
  check("11 a second switch is refused", !second.ok)

  const un = await undoGoLive(res.runId as string, actor)
  console.log("      undo:", JSON.stringify(un))
  const after = await snapshot()
  check("12 undo put every record back exactly (names, types, visibility, status, links)", JSON.stringify(after.docs) === JSON.stringify(before.docs))
  check("13 undo made the company and its people hidden study copies again", after.owner[0]?.study_only === true && JSON.stringify(after.people) === JSON.stringify(before.people))
  check("14 the company reads as 'drive' again", (await companyDocState(acct.id)) === "drive")

  // failure path: a stored copy that is not the bytes the approved copy recorded (its fingerprint differs)
  await q("update store_import_items i set sha256 = reverse(sha256) where i.sha256 is not null and i.run_id in (select id from store_import_runs where owner_id=$1 and mode='copy')", [ownerId])
  try {
    const bad = await runGoLive(acct.id, actor)
    console.log("      bad run:", bad.ok, bad.message.slice(0, 160))
    check("15 a stored copy that is not the approved bytes stops the switch", !bad.ok && /Nothing was switched/.test(bad.message), bad.message)
    const after2 = await snapshot()
    check("16 and leaves every record exactly as it was", JSON.stringify(after2.docs) === JSON.stringify(before.docs))
    check("17 and the company stays a hidden study copy", after2.owner[0]?.study_only === true && (await companyDocState(acct.id)) === "drive")
  } finally {
    await q("update store_import_items i set sha256 = reverse(sha256) where i.sha256 is not null and i.run_id in (select id from store_import_runs where owner_id=$1 and mode='copy')", [ownerId])
  }
  const kept = await q("select status, portal_visible from documents where id=$1", [newer])
  void kept
  } finally {
    await q("delete from documents where id = any($1)", [[oldDup, newer]])
    await db.end()
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
