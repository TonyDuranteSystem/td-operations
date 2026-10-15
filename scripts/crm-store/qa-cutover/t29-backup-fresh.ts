/* eslint-disable no-console */
/* sandbox only, REAL sandbox Drive: the fresh backup builds a new tree under new roots, never touches an old folder, and a second run changes nothing */
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
  const { backupOwner } = await import("@/lib/crm-store/backup")

  // an "old" folder (stands for the client's old Drive folder) and the NEW roots
  const stamp = Date.now()
  const old = await drive.createFolder(driveId, `ZZ T29 old client folder ${stamp}`)
  const top = await drive.createFolder(driveId, `ZZ T29 TD clients backup from the CRM ${stamp}`)
  const companies = await drive.createFolder(top.id, "Companies")
  const people = await drive.createFolder(top.id, "People")
  const cfg = { mainDriveId: driveId, companiesRoot: companies.id, peopleRoot: people.id, fresh: true }

  const owner = (await q("select o.id from store_owners o join accounts a on a.id=o.account_id where a.company_name='Test Company LLC' and o.kind='company'"))[0].id as string
  await q("update accounts set drive_folder_id=$1 where company_name='Test Company LLC'", [old.id])
  await q("delete from store_backup_state where owner_id=$1", [owner])
  const kidsOf = async (id: string) => ((await drive.listFolder(id, 100)) as { files?: Array<{ id: string; name: string }> }).files ?? []
  try {
    const r1 = await backupOwner(owner, { config: cfg, force: true })
    ck("1 the first fresh backup is done", r1.status === "done", r1)
    ck("2 the old client folder was not touched (still empty)", (await kidsOf(old.id)).length === 0, await kidsOf(old.id))
    const state = (await kidsOf(companies.id)).find((f) => f.name === "Wyoming" || f.name.length > 0)
    ck("3 the new tree was built under the new Companies folder", !!state, await kidsOf(companies.id))
    const refs = await q("select drive_path->>'adopted' adopted, object_kind from store_external_refs where direction='backup' and object_id in (select id from store_folders where owner_id=$1)", [owner])
    ck("4 no folder was adopted", refs.length > 0 && refs.every((x) => x.adopted === "false"), refs)
    const st = (await q("select first_backup_at is not null done, consecutive_failures from store_backup_state where owner_id=$1", [owner]))[0]
    ck("5 the storage's first backup is recorded", st?.done === true && st.consecutive_failures === 0, st)
    const r2 = await backupOwner(owner, { config: cfg, force: true })
    ck("6 a second run changes nothing", r2.status === "done" && r2.uploaded === 0 && r2.updated === 0 && r2.moved === 0 && r2.recreated === 0, r2)
  } finally {
    await db.query("update accounts set drive_folder_id=null where company_name='Test Company LLC' and drive_folder_id=$1", [old.id]).catch(() => undefined)
    for (const id of [top.id, old.id]) await drive.trashFile(id).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
