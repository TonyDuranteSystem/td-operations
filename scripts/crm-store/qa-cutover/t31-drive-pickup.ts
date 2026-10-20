/* eslint-disable no-console */
/* sandbox only, REAL sandbox Drive: the Drive pickup brings one named file from a company's old Drive folder into its storage (3. Tax > year), hidden from the client, once */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"
async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  if (process.env.GOOGLE_DRIVE_LIVE !== "1") throw new Error("run with GOOGLE_DRIVE_LIVE=1 and the sandbox GOOGLE_SHARED_DRIVE_ID")
  const driveId = process.env.GOOGLE_SHARED_DRIVE_ID as string
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const drive = await (await import("../_drive-fixture")).driveFixture()
  const { runPickupBatch, PICKUP_SLUG } = await import("@/lib/crm-store/drive-pickup")

  const stamp = Date.now()
  const root = await drive.createFolder(driveId, `ZZ T31 pickup ${stamp}`)
  const tax = await drive.createFolder(root.id, "3. Tax")
  const y = await drive.createFolder(tax.id, "2025")
  const NAME = `T31_Signed_for_IRS_${stamp}.pdf`
  await drive.uploadBinaryToDrive(NAME, Buffer.from("%PDF-1.4 t31 pickup"), "application/pdf", y.id)
  const before = (await q("select drive_folder_id from accounts where company_name='Test Company LLC'"))[0]?.drive_folder_id as string | null
  const acct = (await q("select id from accounts where company_name='Test Company LLC'"))[0].id as string
  await q("update accounts set drive_folder_id=$1 where id=$2", [root.id, acct])
  await q("delete from system_docs where slug=$1", [PICKUP_SLUG])
  const list = { items: [
    { accountId: acct, company: "Test Company LLC", name: NAME, documentType: "tax_return", year: 2025, status: "pending" },
    { accountId: acct, company: "Test Company LLC", name: "does-not-exist.pdf", documentType: "tax_return", year: 2025, status: "pending" },
  ] }
  await q("insert into system_docs (slug, title, content, doc_type, agent_readable) values ($1, 'T31', $2, 'report', false)", [PICKUP_SLUG, JSON.stringify(list)])
  try {
    const r1 = await runPickupBatch({ budgetMs: 120_000 })
    ck("1 one file done, the missing one skipped (never guessed)", r1.done === 1 && r1.skipped === 1 && r1.failed === 0, r1)
    const f = (await q("select f.name, f.document_type, f.period_year, f.published, fo.name folder, p.name parent from store_files f join store_folders fo on fo.id=f.folder_id join store_folders p on p.id=fo.parent_id join store_owners o on o.id=f.owner_id where o.account_id=$1 and f.name=$2 and f.state='live'", [acct, NAME]))
    ck("2 saved in 3. Tax > 2025 with the type and year", f.length === 1 && f[0].folder === "2025" && f[0].parent === "3. Tax" && f[0].document_type === "tax_return" && f[0].period_year === 2025, f)
    ck("3 hidden from the client", f[0]?.published === false, f)
    const d = (await q("select portal_visible from documents where account_id=$1 and file_name=$2", [acct, NAME]))
    ck("4 the CRM documents row exists and is not client-visible", d.length === 1 && d[0].portal_visible === false, d)
    const n1 = (await q("select count(*)::int n from store_files f join store_owners o on o.id=f.owner_id where o.account_id=$1 and f.name=$2", [acct, NAME]))[0].n
    const r2 = await runPickupBatch({ budgetMs: 120_000 })
    const n2 = (await q("select count(*)::int n from store_files f join store_owners o on o.id=f.owner_id where o.account_id=$1 and f.name=$2", [acct, NAME]))[0].n
    ck("5 a second run adds nothing", n1 === 1 && n2 === 1 && r2.pending === 0, { n1, n2, r2 })
  } finally {
    await db.query("delete from documents where account_id=$1 and file_name=$2", [acct, NAME]).catch(() => undefined)
    await db.query("update accounts set drive_folder_id=$1 where id=$2", [before, acct]).catch(() => undefined)
    await db.query("delete from system_docs where slug=$1", [PICKUP_SLUG]).catch(() => undefined)
    await drive.trashFile(root.id).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
