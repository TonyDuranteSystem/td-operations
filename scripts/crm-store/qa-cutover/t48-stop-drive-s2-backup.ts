/* eslint-disable no-console */
/**
 * Stop Drive S2 (dev job 264bb882) — SANDBOX ONLY, REAL TEST Shared Drive: the REAL one-way backup still works end to end after the
 * Drive write switch, and it writes ONLY under its own backup root.
 *
 * What it proves:
 *   1 the backup of a real sandbox storage runs to "done" and really wrote to Drive (folders + files) — the switch lets the backup through;
 *   2 EVERY write request the backup sent targeted the backup root or something created under it (nothing else in the test Drive was touched);
 *   3 a second run changes nothing (idempotent);
 *   4 while / after the backup, a write from outside the backup scope is refused and sends no request;
 *   5 an old "client" folder placed next to the backup stays empty.
 * Run (sandbox env in .env.local + the TEST drive):  GOOGLE_DRIVE_LIVE=1 GOOGLE_SHARED_DRIVE_ID=<test drive> npx tsx scripts/crm-store/qa-cutover/t48-stop-drive-s2-backup.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"

type Req = { method: string; url: string; body: string | null }
const writes: Req[] = []
const createdIds = new Set<string>()

function installSpy() {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const res = await real(input as never, init)
    const isDrive = /googleapis\.com\/(upload\/)?drive\/v3/.test(url) || /upload_id=/.test(url)
    if (isDrive && method !== "GET" && method !== "HEAD") {
      writes.push({ method, url, body: typeof init?.body === "string" ? init.body : null })
      try {
        const j = (await res.clone().json()) as { id?: string }
        if (j?.id) createdIds.add(j.id)
      } catch { /* a 308 / empty answer */ }
    }
    return res
  }) as typeof fetch
}

/** every Drive id a write request named: the file in the URL, the parents in the body, addParents */
function idsOf(r: Req): string[] {
  const ids: string[] = []
  const m = /\/files\/([A-Za-z0-9_-]+)/.exec(r.url)
  if (m) ids.push(m[1])
  const add = /[?&]addParents=([A-Za-z0-9_,-]+)/.exec(r.url)
  if (add) ids.push(...add[1].split(","))
  if (r.body) { try { const b = JSON.parse(r.body) as { parents?: string[] }; if (Array.isArray(b.parents)) ids.push(...b.parents) } catch { /* multipart */ } }
  return ids
}

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("sandbox only: refusing to run")
  if (process.env.GOOGLE_DRIVE_LIVE !== "1") throw new Error("run with GOOGLE_DRIVE_LIVE=1 and the TEST Shared Drive in GOOGLE_SHARED_DRIVE_ID")
  const driveId = (process.env.GOOGLE_SHARED_DRIVE_ID ?? "").trim()
  if (!driveId || driveId === "0AOLZHXSfKUMHUk9PVA") throw new Error("GOOGLE_SHARED_DRIVE_ID must be the TEST Shared Drive")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const drive = await (await import("../_drive-fixture")).driveFixture()
  const realDrive = await import("../../../lib/google-drive")
  const { DriveWritesStoppedError } = await import("../../../lib/google-drive-write-scope")
  const { backupOwner } = await import("../../../lib/crm-store/backup")
  installSpy()

  const stamp = Date.now()
  const old = await drive.createFolder(driveId, `ZZ T48 old client folder ${stamp}`)
  const top = await drive.createFolder(driveId, `ZZ T48 TD clients backup from the CRM ${stamp}`)
  const companies = await drive.createFolder(top.id, "Companies")
  const people = await drive.createFolder(top.id, "People")
  const cfg = { mainDriveId: driveId, companiesRoot: companies.id, peopleRoot: people.id, fresh: true }
  const kidsOf = async (id: string) => ((await realDrive.listFolder(id, 100)) as { files?: Array<{ id: string; name: string }> }).files ?? []
  const chains = new Map<string, string[]>()
  const ancestorIsTop = async (id: string): Promise<boolean> => {
    let cur: string | null = id
    const chain: string[] = []
    for (let i = 0; i < 20 && cur; i++) {
      chain.push(cur)
      if (cur === top.id) { chains.set(id, chain); return true }
      const item: { parents?: string[] } | null = await realDrive.getTaggedItem(cur).catch(() => null)
      cur = item?.parents?.[0] ?? null
    }
    chains.set(id, chain)
    return false
  }

  const owner = (await q("select o.id from store_owners o join accounts a on a.id=o.account_id where a.company_name='Test Company LLC' and o.kind='company'"))[0].id as string
  const originalFolder = (await q("select drive_folder_id from accounts where company_name='Test Company LLC'"))[0].drive_folder_id as string | null
  await q("update accounts set drive_folder_id=$1 where company_name='Test Company LLC'", [old.id])
  // a clean slate for this storage's backup records (the previous run of this script left copies in a folder it trashed)
  const clearBackupRecords = async () => {
    await q("delete from store_external_refs where direction='backup' and object_id in (select id from store_files where owner_id=$1 union select id from store_folders where owner_id=$1)", [owner])
    await q("delete from store_backup_state where owner_id=$1", [owner])
  }
  // The backup remembers its fixed "places" (state folders, _In formation, _Unfiled …) in the database across runs, and an earlier run of
  // another test left some pointing at OTHER folders of the test Drive. So that this proof can say "everything is under THIS backup root",
  // the sandbox's place records are set aside for the run and put back exactly as they were afterwards.
  const savedPlaces = await q("select place_key, drive_id, claim_token, claim_until from store_backup_places")
  const restorePlaces = async () => {
    await q("delete from store_backup_places")
    for (const p of savedPlaces) await q("insert into store_backup_places (place_key, drive_id, claim_token, claim_until) values ($1,$2,$3,$4)", [p.place_key, p.drive_id, p.claim_token, p.claim_until])
  }
  await q("delete from store_backup_places")
  await clearBackupRecords()
  const setupWrites = writes.length // the fixture folders above (made through the backup-scoped fixture handle)
  try {
    const r1 = await backupOwner(owner, { config: cfg, force: true })
    const backupWrites = writes.slice(setupWrites)
    ck("1 the real backup ran to done and really wrote to Drive", r1.status === "done" && backupWrites.length > 0, { r1, writes: backupWrites.length })
    console.log(`      ${backupWrites.length} Drive write requests; uploaded ${r1.uploaded}`)

    // 2 every write the backup sent targeted the backup root or something under it
    const touched = Array.from(new Set(backupWrites.flatMap(idsOf)))
    const outside: string[] = []
    for (const id of touched) if (!(await ancestorIsTop(id))) outside.push(id)
    ck("2 EVERY write request targeted the backup root or a thing created under it (none anywhere else)", outside.length === 0 && touched.length > 0, { outside, touched: touched.length, chains: outside.map((id) => chains.get(id)) })
    ck("2b every file / folder the backup created sits under the backup root", (await Promise.all(Array.from(createdIds).filter((id) => ![old.id, top.id, companies.id, people.id].includes(id)).map(ancestorIsTop))).every(Boolean))

    // 5 the old client folder is untouched
    ck("5 the old client folder next to the backup stayed empty", (await kidsOf(old.id)).length === 0, await kidsOf(old.id))

    // 3 idempotent
    const before = writes.length
    const r2 = await backupOwner(owner, { config: cfg, force: true })
    ck("3 a second run changes nothing", r2.status === "done" && r2.uploaded === 0 && r2.updated === 0 && r2.moved === 0 && r2.recreated === 0 && writes.length === before, { r2, newWrites: writes.length - before })

    // 4 outside the backup scope a write is refused and sends nothing
    const n = writes.length
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["createFolder", () => realDrive.createFolder(top.id, "must-not-exist")],
      ["uploadBinaryToDrive", () => realDrive.uploadBinaryToDrive("x.txt", Buffer.from("x"), "text/plain", top.id)],
      ["trashFile", () => realDrive.trashFile(companies.id)],
      ["renameFile", () => realDrive.renameFile(companies.id, "renamed")],
    ]
    let refused = 0
    for (const [, run] of attempts) { try { await run() } catch (e) { if (e instanceof DriveWritesStoppedError) refused++ } }
    ck("4 outside the backup, every write attempt is refused and not one request is sent", refused === attempts.length && writes.length === n, { refused, newWrites: writes.length - n })
    ck("4b nothing named must-not-exist was created", !(await kidsOf(top.id)).some((f) => f.name === "must-not-exist"))
  } finally {
    await db.query("update accounts set drive_folder_id=$1 where company_name='Test Company LLC'", [originalFolder]).catch(() => undefined)
    await clearBackupRecords().catch(() => undefined) // (the copies are trashed below, so their records are dropped too)
    await restorePlaces().catch((e) => console.error("COULD NOT RESTORE the sandbox place records — restore by hand:", JSON.stringify(savedPlaces), e))
    // trash every copy individually (the backup finds its own tagged copies, so a trashed parent alone would not hide them from a re-run)
    for (const id of Array.from(createdIds)) await drive.trashFile(id).catch(() => undefined)
    for (const id of [top.id, old.id]) await drive.trashFile(id).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
