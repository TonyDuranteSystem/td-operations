/* eslint-disable no-console */
/* sandbox only: the unsigned SS-4 is stored in 1. Company (versioned), a Drive company is untouched; ITIN papers go to the ITIN folder with their types */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"
async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows

  // ── SS-4: a company in the new storage
  const { storeUnsignedSs4 } = await import("@/lib/operations/ss4-store")
  const { ensurePersonOwner, COMPANY_TEMPLATE, storeSafeFolderName } = await import("@/lib/crm-store/formation-pilot")
  const ACC = "597af4fa-df7a-4200-816b-7375e82390b5" // Test Company LLC (draft SS-4)
  const co = (await q("select company_name from accounts where id=$1", [ACC]))[0].company_name as string
  const ownerId = (await db.query("select store_ensure_owner('company', $1) id", [ACC])).rows[0].id as string
  await db.query("select store_apply_template($1, $2, $3)", [ownerId, COMPANY_TEMPLATE, storeSafeFolderName(co)])
  const live = (await q("select study_only from store_owners where id=$1", [ownerId]))[0]
  ck("0 the test company has a live storage", live.study_only === false, live)
  const s1 = await storeUnsignedSs4(ACC, "t28")
  ck("1 the unsigned SS-4 is stored", s1.stored, s1)
  const files = async () => q("select f.id, f.name, f.document_type, f.published, fo.kind folder_kind, (select count(*) from store_file_versions v where v.file_id=f.id)::int versions from store_files f join store_folders fo on fo.id=f.folder_id where f.owner_id=$1 and f.state='live' and f.name like 'Form SS-4%Unsigned%'", [ownerId])
  const f1 = await files()
  ck("2 it sits in 1. Company, typed Form SS-4, hidden from the client", f1.length === 1 && f1[0].folder_kind === "company" && f1[0].document_type === "form_ss_4" && f1[0].published === false, f1)
  const s2 = await storeUnsignedSs4(ACC, "t28-again")
  const f2 = await files()
  ck("3 saving again never makes a second file (the refresh only calls it when a field changed)", s2.stored && f2.length === 1 && f2[0].id === f1[0].id, { s2, f1, f2 })
  const old = (await q("select responsible_party_name from ss4_applications where account_id=$1 and status in ('draft','awaiting_signature') order by created_at desc limit 1", [ACC]))[0].responsible_party_name
  await q("update ss4_applications set responsible_party_name=$2 where id=(select id from ss4_applications where account_id=$1 and status in ('draft','awaiting_signature') order by created_at desc limit 1)", [ACC, "ZZ T28 Changed Person"])
  const s3 = await storeUnsignedSs4(ACC, "t28-changed")
  const f3 = await files()
  ck("4 a changed SS-4 becomes a NEW VERSION of the same file", s3.stored && f3.length === 1 && f3[0].id === f1[0].id && f3[0].versions > f2[0].versions, { s3, f2, f3 })
  await q("update ss4_applications set responsible_party_name=$2 where id=(select id from ss4_applications where account_id=$1 and status in ('draft','awaiting_signature') order by created_at desc limit 1)", [ACC, old])
  // a company still on Drive
  const sd = await storeUnsignedSs4("b7d8cdee-0143-4f49-9411-e409542c5cda".replace("b7d8cdee-0143-4f49-9411-e409542c5cda", (await q("select account_id from ss4_applications where id='b7d8cdee-0143-4f49-9411-e409542c5cda'"))[0].account_id), "t28-drive")
  ck("5 a company still on Drive is left alone", !sd.stored && /Drive/.test(sd.reason), sd)

  // ── ITIN papers
  const { saveDocumentForContact } = await import("@/lib/crm-store/save-for-account")
  const person = (await q("select o.contact_id, c.full_name from store_owners o join contacts c on c.id=o.contact_id where o.kind='person' and o.study_only=false and exists (select 1 from store_folders fo where fo.owner_id=o.id and fo.kind='itin' and fo.trashed_at is null) limit 1"))[0]
  const stamp = Date.now()
  const saved: string[] = []
  for (const [name, type] of [["W-7", "form_w_7"], ["1040-NR", "form_1040_nr"], ["Schedule_OI", "itin_schedule_oi"]] as const) {
    const r = await saveDocumentForContact({ contactId: person.contact_id, contactName: person.full_name, name: `ZZ T28 ${name} ${stamp}.pdf`, bytes: Buffer.from(`pdf ${name}`), mimeType: "application/pdf", documentType: type, folderKind: "itin", portalVisible: true, callerKey: `t28:${stamp}:${name}`, row: { document_type_name: `ITIN ${name}`, category: 3, status: "classified" } })
    if (r.route === "store") saved.push(r.fileId)
  }
  const itin = await q("select f.name, f.document_type, fo.kind from store_files f join store_folders fo on fo.id=f.folder_id where f.id = any($1::uuid[])", [saved])
  ck("6 the three ITIN papers are in the ITIN folder with their types (incl. the new Schedule OI type)", itin.length === 3 && itin.every((x) => x.kind === "itin") && itin.some((x) => x.document_type === "itin_schedule_oi") && itin.some((x) => x.document_type === "form_w_7"), itin)
  for (const id of saved) await q("update store_files set state='trashed', trashed_at=now() where id=$1", [id]).catch(() => undefined)
  await q("delete from documents where drive_file_id = any($1::text[])", [saved.map((x) => `store:${x}`)]).catch(() => undefined)
  console.log(`\n${pass} passed, ${fail} failed`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
