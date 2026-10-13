/* eslint-disable no-console */
/**
 * Go-live catch-up (dev job ad09ea91, master plan Part 33, Phase B2) — SANDBOX only, REAL isolated TEST Shared Drive.
 * A record the CRM made AFTER the approved copy (a real file in the test Drive) must be brought in one file at a time when the
 * company switches; undo must put the record back on its Drive link. A record made BEFORE the copy and not in it stays on Drive.
 * Run: STORE_GO_LIVE=1 npx tsx scripts/crm-store/qa-cutover/t17-go-live-catchup.ts
 */
import { config } from "dotenv"
import { Client } from "pg"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })
process.env.GOOGLE_DRIVE_LIVE = "1"
process.env.GOOGLE_SHARED_DRIVE_ID = "0ABz0eJKly9bkUk9PVA" // the isolated TEST Shared Drive (never the production drive)

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  if (process.env.STORE_GO_LIVE !== "1") throw new Error("set STORE_GO_LIVE=1")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const acct = (await q("select id, company_name from accounts where company_name like 'ZZ Drive Pilot%' order by created_at desc limit 1"))[0]
  const actor = (await q("select id from auth.users limit 1"))[0]?.id as string
  const model = (await q("select document_type_id, document_type_name, category, category_name from documents where account_id=$1 and document_type_name is not null limit 1", [acct.id]))[0]
  const { uploadBinaryToDrive } = await import("../../../lib/google-drive")
  const stamp = Date.now()
  const bytes = Buffer.from(`%PDF-1.4\n% catch-up QA ${stamp}\n%%EOF\n`)
  const up = (await uploadBinaryToDrive(`QA catchup ${stamp}.pdf`, bytes, "application/pdf", process.env.GOOGLE_SHARED_DRIVE_ID as string)) as { id: string }
  console.log("      test Drive file:", up.id)
  const row = (await q(
    `insert into documents (drive_file_id, file_name, mime_type, file_size, account_id, account_name, category, category_name, document_type_id, document_type_name, portal_visible, status, created_at)
     values ($1,$2,'application/pdf',$3,$4,$5,$6,$7,$8,$9,true,'classified', '2025-01-01T00:00:00Z') returning id`,
    [up.id, `QA catchup ${stamp}.pdf`, bytes.length, acct.id, acct.company_name, model?.category ?? 1, model?.category_name ?? "Company", model?.document_type_id ?? null, model?.document_type_name ?? null],
  ))[0]
  console.log("      record:", row.id, "type:", model?.document_type_name)
  const { planGoLive, runGoLive, undoGoLive } = await import("../../../lib/crm-store/go-live-run")
  try {
    const plan = await planGoLive(acct.id)
    console.log("      plan:", JSON.stringify(plan.rows))
    check("1  the new record is planned as a catch-up", plan.rows.catchUp >= 1, JSON.stringify(plan.rows))
    const res = await runGoLive(acct.id, actor)
    console.log("      result:", res.ok, res.message)
    check("2  switch succeeded", res.ok, res.message)
    const after = (await q("select drive_file_id from documents where id=$1", [row.id]))[0]
    check("3  the newer record now points at the new storage", String(after.drive_file_id).startsWith("store:"), after.drive_file_id)
    check("4  and it is typed + open to the client (the portal's own answer)", await (async () => {
      const { clientMayOpen } = await import("../../../lib/portal/client-store-docs")
      return clientMayOpen({ id: row.id, drive_file_id: after.drive_file_id, portal_visible: true, service_delivery_id: null, flow_stage: null })
    })())
    const { openDocument } = await import("../../../lib/documents/open-document")
    const opened = await openDocument(after.drive_file_id)
    check("5  its bytes in storage equal the Drive original", opened.buffer.equals(bytes))
    const un = await undoGoLive(res.runId as string, actor)
    console.log("      undo:", JSON.stringify(un))
    const back = (await q("select drive_file_id from documents where id=$1", [row.id]))[0]
    check("6  undo put the newer record back on its Drive link", back.drive_file_id === up.id, back.drive_file_id)
  } finally {
    await q("delete from documents where id=$1", [row.id])
  }
  await db.end()
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
