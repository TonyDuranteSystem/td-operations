/* eslint-disable no-console */
/* sandbox only: a personal file moves from one person's storage to another person of the same company, and back */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"
const FILE = "abf87aff-622d-4c9a-b3f7-92b7e15f1ae3"
const FROM_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const { peopleForFile, changeFilePerson } = await import("@/lib/crm-store/change-person")
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const state = async () => (await db.query("select o.contact_id, fo.name folder, (select string_agg(d.contact_id::text, ',') from documents d where d.drive_file_id='store:'||f.id) rec_contact from store_files f join store_owners o on o.id=f.owner_id join store_folders fo on fo.id=f.folder_id where f.id=$1", [FILE])).rows[0]

  const before = await state()
  ck("0 starts in the first person's storage", before.contact_id === FROM_CONTACT, before)
  const people = await peopleForFile(FILE)
  ck("1 other people of the company are offered, not the current one", people.length > 0 && !people.some((p) => p.contactId === FROM_CONTACT), people)
  let refused = false
  try { await changeFilePerson(FILE, "00000000-0000-0000-0000-000000000000", null) } catch { refused = true }
  ck("2 a person who is not in the company is refused", refused)
  ck("1b each person says whether they already have a storage", people.every((p) => typeof p.hasStorage === "boolean"), people)
  const to = people[0]
  const r = await changeFilePerson(FILE, to.contactId, null)
  const mid = await state()
  ck("3 the file is now in the other person's storage", mid.contact_id === to.contactId, { mid, r })
  ck("4 its CRM record follows to that person", !mid.rec_contact || mid.rec_contact === to.contactId, mid)
  const back = await changeFilePerson(FILE, FROM_CONTACT, null)
  const end = await state()
  ck("5 and it can be put back", end.contact_id === FROM_CONTACT && (!end.rec_contact || end.rec_contact === FROM_CONTACT), { end, back })
  // the Move picker path: a folder CHOSEN in the other person's storage
  const { moveStoreFile } = await import("@/lib/crm-store/file-actions")
  const tf = (await db.query("select fo.id, fo.name from store_folders fo join store_owners o on o.id=fo.owner_id where o.contact_id=$1 and o.kind='person' and fo.kind='itin' and fo.trashed_at is null limit 1", [to.contactId])).rows[0]
  const m = await moveStoreFile(FILE, tf.id, null)
  const m1 = await state()
  ck("6 the picker move puts it in the chosen folder of the other person", m1.contact_id === to.contactId && m1.folder === tf.name, { m, m1 })
  const root = (await db.query("select fo.id from store_folders fo join store_owners o on o.id=fo.owner_id where o.id=(select owner_id from store_files where id=$1) and fo.kind='root'", [FILE])).rows[0]
  let rootRefused = false
  try { await moveStoreFile(FILE, root.id, null) } catch { rootRefused = true }
  ck("7 the top folder is refused", rootRefused)
  const co = (await db.query("select fo.id from store_folders fo join store_owners o on o.id=fo.owner_id where o.kind='company' and fo.kind='correspondence' and fo.trashed_at is null limit 1")).rows[0]
  let coRefused = false
  try { await moveStoreFile(FILE, co.id, null) } catch { coRefused = true }
  ck("8 a company folder is refused", coRefused)
  const pf = (await db.query("select fo.id from store_folders fo join store_owners o on o.id=fo.owner_id where o.contact_id=$1 and o.kind='person' and fo.kind='personal' and fo.trashed_at is null limit 1", [FROM_CONTACT])).rows[0]
  await moveStoreFile(FILE, pf.id, null)
  const e2 = await state()
  ck("9 and it goes back through the same picker path", e2.contact_id === FROM_CONTACT && (!e2.rec_contact || e2.rec_contact === FROM_CONTACT), e2)
  console.log(`\n${pass} passed, ${fail} failed`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
