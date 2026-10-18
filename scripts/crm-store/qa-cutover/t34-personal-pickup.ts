/* eslint-disable no-console */
/* sandbox only, REAL sandbox Drive: the personal pickup brings a person's own document from Drive into THEIR storage and re-points the SAME CRM record */
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
  const { runPersonalPickupBatch, PERSONAL_PICKUP_SLUG } = await import("@/lib/crm-store/drive-pickup-personal")

  const stamp = Date.now()
  const acct = (await q("select id from accounts where company_name='Test Company LLC'"))[0].id as string
  const root = await drive.createFolder(driveId, `ZZ T34 personal ${stamp}`)
  const NAME = `ZZ_T34_Card_${stamp}.pdf`
  const file = await drive.uploadBinaryToDrive(NAME, Buffer.from("%PDF-1.4 t34 personal card statement"), "application/pdf", root.id)
  const contact = (await q("insert into contacts (full_name) values ('ZZ T34 Person') returning id"))[0].id as string
  const other = (await q("insert into contacts (full_name) values ('ZZ T34 Other') returning id"))[0].id as string
  const docId = (await q(
    "insert into documents (file_name, account_id, contact_id, category, category_name, document_type_name, portal_visible, drive_file_id, mime_type, status) values ($1,$2,$3,2,'Contacts','Credit Card Statement',true,$4,'application/pdf','classified') returning id",
    [NAME, acct, contact, file.id]))[0].id as string
  const wrongDocId = (await q(
    "insert into documents (file_name, account_id, contact_id, category, category_name, document_type_name, portal_visible, drive_file_id, mime_type, status) values ($1,$2,$3,2,'Contacts','Credit Card Statement',true,$4,'application/pdf','classified') returning id",
    [NAME + ".wrong.pdf", acct, other, file.id]))[0].id as string
  await q("delete from system_docs where slug=$1", [PERSONAL_PICKUP_SLUG])
  const list = { items: [
    { documentId: docId, contactId: contact, driveFileId: file.id, name: NAME, documentType: "credit_card_statement", status: "pending" },
    { documentId: wrongDocId, contactId: contact, driveFileId: file.id, name: NAME + ".wrong.pdf", documentType: "credit_card_statement", status: "pending" },
  ] }
  await q("insert into system_docs (slug, title, content, doc_type, agent_readable) values ($1, 'T34', $2, 'report', false)", [PERSONAL_PICKUP_SLUG, JSON.stringify(list)])
  try {
    const hadOwner = (await q("select 1 from store_owners where kind='person' and contact_id=$1", [contact])).length
    const r1 = await runPersonalPickupBatch({ budgetMs: 120_000 })
    ck("1 one done, the record that belongs to someone else skipped (never guessed)", r1.done === 1 && r1.skipped === 1 && r1.failed === 0, r1)
    ck("2 the person had no storage before; it was made", hadOwner === 0 && (await q("select 1 from store_owners where kind='person' and contact_id=$1", [contact])).length === 1)
    const f = await q("select f.name, f.document_type, f.published, fo.kind from store_files f join store_folders fo on fo.id=f.folder_id join store_owners o on o.id=f.owner_id where o.kind='person' and o.contact_id=$1 and f.name=$2", [contact, NAME])
    ck("3 saved in the person's Personal documents with the personal type", f.length === 1 && f[0].kind === "personal" && f[0].document_type === "credit_card_statement", f)
    ck("4 the file is shown to the client like the record was", f[0]?.published === true, f)
    const d = await q("select drive_file_id, contact_id, account_id, portal_visible from documents where id=$1", [docId])
    ck("5 the SAME record now points at the stored copy (no second record)", d.length === 1 && String(d[0].drive_file_id).startsWith("store:") && d[0].contact_id === contact && d[0].portal_visible === true, d)
    ck("6 the skipped record was not touched", (await q("select drive_file_id from documents where id=$1", [wrongDocId]))[0].drive_file_id === file.id)
    const n1 = (await q("select count(*)::int n from documents where file_name=$1", [NAME]))[0].n
    const r2 = await runPersonalPickupBatch({ budgetMs: 120_000 })
    const n2 = (await q("select count(*)::int n from documents where file_name=$1", [NAME]))[0].n
    const sf = (await q("select count(*)::int n from store_files f join store_owners o on o.id=f.owner_id where o.contact_id=$1 and f.name=$2", [contact, NAME]))[0].n
    ck("7 a second run adds nothing", n1 === 1 && n2 === 1 && sf === 1 && r2.pending === 0, { n1, n2, sf, r2 })
  } finally {
    await db.query("delete from documents where id = any($1)", [[docId, wrongDocId]]).catch(() => undefined)
    await db.query("delete from system_docs where slug=$1", [PERSONAL_PICKUP_SLUG]).catch(() => undefined)
    await drive.trashFile(root.id).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed (test person ${contact} and ${other} left for manual cleanup: their storage rows)`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
