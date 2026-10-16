/* eslint-disable no-console */
/* sandbox only, REAL sandbox Drive: the Drive-vs-storage gap check finds a file only Drive has, reads only, and changes nothing */
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
  const drive = await import("@/lib/google-drive")
  const { scanCompanyGap, listGapCompanies } = await import("@/lib/crm-store/drive-gap")

  const stamp = Date.now()
  const root = await drive.createFolder(driveId, `ZZ T30 gap ${stamp}`)
  const tax = await drive.createFolder(root.id, "3. Tax")
  const y = await drive.createFolder(tax.id, "2025")
  const f1 = await drive.uploadBinaryToDrive("T30-only-in-drive.pdf", Buffer.from("%PDF-1.4 t30 a"), "application/pdf", y.id)
  const before = (await q("select drive_folder_id from accounts where company_name='Test Company LLC'"))[0]?.drive_folder_id as string | null
  const acct = (await q("select id from accounts where company_name='Test Company LLC'"))[0].id as string
  await q("update accounts set drive_folder_id=$1 where id=$2", [root.id, acct])
  let runId: string | null = null
  const storeBefore = (await q("select count(*)::int n from store_files"))[0].n as number
  try {
    ck("1 the company is listed for the check", (await listGapCompanies()).some((c) => c.accountId === acct))
    const r = await scanCompanyGap(acct)
    ck("2 the Drive-only file is reported as missing", r.counts.missing === 1 && r.files.some((f) => f.name === "T30-only-in-drive.pdf" && f.kind === "missing" && f.path === "3. Tax › 2025"), r)
    ck("3 total counts the file found two folders down", r.total === 1, r)
    // it is now "recorded as imported" → no longer reported
    // a move that SAW the file (whatever it decided) means it is not new
    const run = (await q("insert into store_import_runs (account_id, mode, status) values ($1, 'copy', 'done') returning id", [acct]))[0].id as string
    runId = run
    await q("insert into store_import_items (run_id, source, source_id, name, status) values ($1, 'drive', $2, 'T30-only-in-drive.pdf', 'done')", [run, f1.id])
    const r2 = await scanCompanyGap(acct)
    ck("4 once a move has seen it (and decided), it is not reported", r2.counts.imported === 1 && r2.counts.missing === 0, r2)
    ck("5 the check changed nothing in storage", (await q("select count(*)::int n from store_files"))[0].n === storeBefore)
  } finally {
    if (runId) { await db.query("delete from store_import_items where run_id=$1", [runId]).catch(() => undefined); await db.query("delete from store_import_runs where id=$1", [runId]).catch(() => undefined) }
    await db.query("update accounts set drive_folder_id=$1 where id=$2", [before, acct]).catch(() => undefined)
    await drive.trashFile(root.id).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
