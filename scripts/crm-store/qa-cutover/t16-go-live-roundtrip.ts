/* eslint-disable no-console */
/**
 * Go-live (dev job ad09ea91, master plan Part 33, Phase B1) — SANDBOX ONLY, direct library calls on test companies.
 * Dry run → switch → check the records moved → undo → check everything is back exactly as it was.
 * Run: STORE_GO_LIVE=1 npx tsx scripts/crm-store/qa-cutover/t16-go-live-roundtrip.ts "<company name starts with>"
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
  const snapshot = async () => ({
    docs: await q("select id, drive_file_id, drive_link from documents where account_id=$1 order by id", [acct.id]),
    owner: await q("select id, study_only from store_owners where account_id=$1 and kind='company'", [acct.id]),
  })
  const before = await snapshot()

  const { planGoLive, runGoLive } = await import("../../../lib/crm-store/go-live-run")
  const { undoGoLive } = await import("../../../lib/crm-store/go-live-run")
  const actor = (await q("select id from auth.users limit 1"))[0]?.id as string

  const plan = await planGoLive(acct.id)
  console.log("      plan:", JSON.stringify({ may: plan.mayGoLive, blockers: plan.blockers, rows: plan.rows }))
  check("1  dry run changed nothing", JSON.stringify(await snapshot()) === JSON.stringify(before))
  check("2  dry run says it may switch", plan.mayGoLive, plan.blockers.join("; "))

  const res = await runGoLive(acct.id, actor)
  console.log("      result:", res.ok, res.message)
  check("3  switch succeeded", res.ok, res.message)
  const mid = await snapshot()
  check("4  company is now live (not a hidden study copy)", mid.owner[0]?.study_only === false)
  const moved = mid.docs.filter((d: { drive_file_id: string }) => d.drive_file_id.startsWith("store:")).length
  const wasStore = before.docs.filter((d: { drive_file_id: string }) => d.drive_file_id.startsWith("store:")).length
  check("5  the planned number of records now point at storage", moved - wasStore === res.repointed, `${moved - wasStore} vs ${res.repointed}`)
  const { companyDocState } = await import("../../../lib/crm-store/switched-drive-guard")
  check("6  the company reads as 'store'", (await companyDocState(acct.id)) === "store")
  const second = await runGoLive(acct.id, actor)
  check("7  a second switch is refused", !second.ok)

  const un = await undoGoLive(res.runId as string, actor)
  console.log("      undo:", JSON.stringify(un))
  const after = await snapshot()
  check("8  undo put every record back exactly", JSON.stringify(after.docs) === JSON.stringify(before.docs))
  check("9  undo made the company a hidden study copy again", after.owner[0]?.study_only === true)
  check("10 the company reads as 'drive' again", (await companyDocState(acct.id)) === "drive")

  // failure path: a stored copy whose size differs from what the approved copy recorded must stop the switch and leave everything as it was
  const ownerId = before.owner[0].id as string
  await q("update store_import_items i set size_bytes = size_bytes + 1 where i.size_bytes is not null and i.run_id in (select id from store_import_runs where owner_id=$1 and mode='copy')", [ownerId])
  try {
    const bad = await runGoLive(acct.id, actor)
    console.log("      bad run:", bad.ok, bad.message.slice(0, 160))
    check("11 a size difference stops the switch", !bad.ok && /Nothing was switched/.test(bad.message), bad.message)
    const after2 = await snapshot()
    check("12 and leaves every record exactly as it was", JSON.stringify(after2.docs) === JSON.stringify(before.docs))
    check("13 and the company stays a hidden study copy", after2.owner[0]?.study_only === true && (await companyDocState(acct.id)) === "drive")
  } finally {
    await q("update store_import_items i set size_bytes = size_bytes - 1 where i.size_bytes is not null and i.run_id in (select id from store_import_runs where owner_id=$1 and mode='copy')", [ownerId])
  }
  await db.end()
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
