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
  const storeBefore = (await q("select count(*)::int n from store_files"))[0].n as number
  try {
    ck("1 the company is listed for the check", (await listGapCompanies()).some((c) => c.accountId === acct))
    const r = await scanCompanyGap(acct)
    ck("2 the Drive-only file is reported as missing", r.counts.missing === 1 && r.files.some((f) => f.name === "T30-only-in-drive.pdf" && f.kind === "missing" && f.path === "3. Tax › 2025"), r)
    ck("3 total counts the file found two folders down", r.total === 1, r)
    // it is now "recorded as imported" → no longer reported
    await q("insert into store_external_refs (object_kind, object_id, provider, direction, external_id, status) select 'file', f.id, 'gdrive', 'import', $1, 'ok' from store_files f limit 1", [f1.id])
    const r2 = await scanCompanyGap(acct)
    ck("4 once the move recorded it, it is not reported", r2.counts.imported === 1 && r2.counts.missing === 0, r2)
    ck("5 the check changed nothing in storage", (await q("select count(*)::int n from store_files"))[0].n === storeBefore)
  } finally {
    await db.query("delete from store_external_refs where provider='gdrive' and direction='import' and external_id=$1", [f1.id]).catch(() => undefined)
    await db.query("update accounts set drive_folder_id=$1 where id=$2", [before, acct]).catch(() => undefined)
    await drive.trashFile(root.id).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
