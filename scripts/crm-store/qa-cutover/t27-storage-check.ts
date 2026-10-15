/* eslint-disable no-console */
/* sandbox only: the Storage check on Uxio Test LLC — name, person without storage, misfiled document, left note, dismiss, stale apply */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"
const ACC = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const { storageCheckFor, applyStorageCheck, recordPersonLeaving, dismissFinding } = await import("@/lib/crm-store/storage-check")
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const kinds = async () => (await storageCheckFor(ACC)).findings.map((f) => f.kind)

  const orig = (await q("select company_name from accounts where id=$1", [ACC]))[0].company_name as string
  const own = (await q("select id from store_owners where account_id=$1 and kind='company'", [ACC]))[0].id as string
  const rootOf = async () => (await q("select name from store_folders where owner_id=$1 and parent_id is null and trashed_at is null", [own]))[0].name as string
  try {
    // 1. the company folder name
    const before = await storageCheckFor(ACC)
    ck("1a company is in the new storage", before.inStorage)
    await q("update accounts set company_name=$2 where id=$1", [ACC, `${orig} Renamed`])
    const r1 = (await storageCheckFor(ACC)).findings.find((f) => f.kind === "folder_name_differs")
    ck("1b a renamed company shows 'folder name differs'", !!r1, await kinds())
    const a1 = await applyStorageCheck(ACC, [{ key: r1!.key, action: "rename_folder" }], null)
    ck("1c Apply renames the storage folder", a1[0].ok && (await rootOf()) === `${orig} Renamed`, { a1, root: await rootOf() })
    ck("1d the finding is gone after Apply", !(await kinds()).includes("folder_name_differs"))
    const stale = await applyStorageCheck(ACC, [{ key: r1!.key, action: "rename_folder" }], null)
    ck("1e applying the same thing again is refused as already handled", !stale[0].ok && /already handled/.test(stale[0].message), stale)
    await q("update accounts set company_name=$2 where id=$1", [ACC, orig])
    const back = (await storageCheckFor(ACC)).findings.find((f) => f.kind === "folder_name_differs")
    if (back) await applyStorageCheck(ACC, [{ key: back.key, action: "rename_folder" }], null)
    ck("1f put back", (await rootOf()) === orig, await rootOf())

    // 2. a person without a storage (a fresh ZZ person is linked to the company for this test)
    const zz = (await q("insert into contacts (full_name) values ($1) returning id", [`ZZ T27 Person ${Date.now()}`]))[0].id as string
    await q("insert into account_contacts (account_id, contact_id, role) values ($1,$2,'Member')", [ACC, zz])
    const noStore = (await storageCheckFor(ACC)).findings.find((f) => f.kind === "person_without_storage" && f.data.contactId === zz)
    ck("2a a person with no storage is listed (pre-ticked create)", !!noStore && noStore.actions[0].defaultOn, await kinds())
    if (noStore) {
      const a2 = await applyStorageCheck(ACC, [{ key: noStore.key, action: "create_person_storage" }], null)
      const has = (await q("select 1 from store_owners where contact_id=$1 and kind='person'", [noStore.data.contactId as string])).length
      ck("2b Apply creates their storage", a2[0].ok && has === 1, a2)
    }

    await q("delete from account_contacts where account_id=$1 and contact_id=$2", [ACC, zz])
    // 3. a document that looks like another person's
    const pair = await q(`select f.id fid, f.name fname, o.contact_id owner_c, (select c2.full_name from account_contacts ac2 join contacts c2 on c2.id=ac2.contact_id where ac2.account_id=$1 and ac2.contact_id<>o.contact_id and exists (select 1 from store_owners o2 where o2.contact_id=ac2.contact_id and o2.kind='person') limit 1) other_name, (select ac2.contact_id from account_contacts ac2 where ac2.account_id=$1 and ac2.contact_id<>o.contact_id and exists (select 1 from store_owners o2 where o2.contact_id=ac2.contact_id and o2.kind='person') limit 1) other_id
      from store_files f join store_owners o on o.id=f.owner_id and o.kind='person' where f.state='live' and o.contact_id in (select contact_id from account_contacts where account_id=$1) limit 1`, [ACC])
    const fx = pair[0]
    const otherToken = String(fx.other_name).split(" ").filter((t: string) => t.length >= 4).pop() as string
    await q("update store_files set name=$2 where id=$1", [fx.fid, `zz_${otherToken}_Passport.pdf`])
    const mis = (await storageCheckFor(ACC)).findings.find((f) => f.kind === "misfiled_document" && f.data.fileId === fx.fid)
    ck("3a a file named for another person is suggested, NOT pre-ticked", !!mis && mis.actions[0].defaultOn === false, await kinds())
    if (mis) {
      const a3 = await applyStorageCheck(ACC, [{ key: mis.key, action: "move_document" }], null)
      const now = (await q("select o.contact_id from store_files f join store_owners o on o.id=f.owner_id where f.id=$1", [fx.fid]))[0].contact_id
      ck("3b Apply moves it to the other person", a3[0].ok && now === fx.other_id, { a3, now })
    }
    // put it back
    const { changeFilePerson } = await import("@/lib/crm-store/change-person")
    await changeFilePerson(fx.fid, fx.owner_c, null).catch(() => undefined)
    await q("update store_files set name=$2 where id=$1", [fx.fid, fx.fname])

    // 4. a person removed by a CRM button
    await recordPersonLeaving({ accountId: ACC, contactId: fx.owner_c, personName: "Leaving Person", actorId: null, via: "test" })
    const left = (await storageCheckFor(ACC)).findings.find((f) => f.kind === "person_left")
    ck("4a a removal is remembered and shown", !!left, await kinds())
    if (left) {
      const a4 = await applyStorageCheck(ACC, [{ key: left.key, action: "mark_seen" }], null)
      ck("4b 'Mark as seen' closes it", a4[0].ok && !(await kinds()).includes("person_left"), a4)
    }
    // 5. not an issue
    await q("update accounts set company_name=$2 where id=$1", [ACC, `${orig} X`])
    const r5 = (await storageCheckFor(ACC)).findings.find((f) => f.kind === "folder_name_differs")
    await dismissFinding(ACC, r5!.key, null)
    ck("5a 'Not an issue' hides the finding", !(await kinds()).includes("folder_name_differs"))
    await q("delete from storage_check_notes where account_id=$1 and kind='dismissed'", [ACC])
    ck("5b removing the note brings it back", (await kinds()).includes("folder_name_differs"))
    await q("update accounts set company_name=$2 where id=$1", [ACC, orig])
  } finally {
    await q("update accounts set company_name=$2 where id=$1", [ACC, orig])
    await q("delete from storage_check_notes where account_id=$1", [ACC])
    const cur = await rootOf()
    if (cur !== orig) await db.query("select store_rename_root($1,$2,null)", [own, orig])
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
