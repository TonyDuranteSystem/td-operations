/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ T37" rows) */
/**
 * Reactivation brings a company's old documents back into storage (Storage check Phase 3, slice 3a; dev job f855295a) — SANDBOX ONLY,
 * REAL files in the sandbox TEST Shared Drive. A throw-away Closed company with a few Drive files and CRM records is flipped to Active;
 * the cron's batch runs; the files must be in storage, each CRM record points at its stored file (no duplicate records), the company is
 * "store", the Calendar got the notes, and a SECOND run adds nothing. Also: reactivated twice, no Drive folder, empty Drive folder.
 * Run: STORE_REACTIVATION=1 GOOGLE_DRIVE_LIVE=1 GOOGLE_SHARED_DRIVE_ID=0ABz0eJKly9bkUk9PVA npx tsx scripts/crm-store/qa-cutover/t37-reactivation.ts
 */
import { config } from "dotenv"
import { Client } from "pg"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const ck = (m: string, c: unknown, x?: unknown) => check(m, !!c, x === undefined ? "" : typeof x === "string" ? x : JSON.stringify(x).slice(0, 300))
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  if (process.env.STORE_REACTIVATION !== "1") throw new Error("set STORE_REACTIVATION=1")
  if (process.env.GOOGLE_DRIVE_LIVE !== "1" || process.env.GOOGLE_SHARED_DRIVE_ID !== TEST_DRIVE) throw new Error("run with GOOGLE_DRIVE_LIVE=1 and the sandbox GOOGLE_SHARED_DRIVE_ID")
  process.env.SANDBOX_MODE = "1"
  delete process.env.STORE_GO_LIVE // prove the night-run switch is NOT needed
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const tag = Date.now()
  const drive = await import("../../../lib/google-drive")
  const { runReactivationBatch, REACTIVATION_SLUG } = await import("../../../lib/crm-store/reactivation")
  const { companyDocState } = await import("../../../lib/crm-store/switched-drive-guard")
  const { processAccountStatusEvents } = await import("../../../lib/accounts/status-change")

  const made: { accounts: string[]; folders: string[] } = { accounts: [], folders: [] }
  const mkBytes = (body: string) => Buffer.from(`%PDF-1.4\n% ZZ T37 ${tag} ${body}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`)
  const marker = new Date().toISOString()
  const notesOf = async (accountId: string) => (await q("select message from portal_messages where account_id=$1 and message like '%kind=account_status_changed%' and created_at >= $2 order by created_at", [accountId, marker])).map((r) => r.message as string)
  const savedState = (await q("select content from system_docs where slug=$1", [REACTIVATION_SLUG]))[0]?.content as string | undefined
  await q("delete from system_docs where slug=$1", [REACTIVATION_SLUG])

  try {
    // ───────────────────────── company A: Closed, a real Drive folder with files, CRM records pointing at them
    console.log("\nfixtures: a Closed company with real Drive files + CRM records")
    const root = await drive.createFolder(TEST_DRIVE, `ZZ T37 reactivation ${tag}`)
    made.folders.push(root.id)
    const co = await drive.createFolder(root.id, "1. Company")
    const tax = await drive.createFolder(root.id, "3. Tax")
    const y24 = await drive.createFolder(tax.id, "2024")
    const up = async (name: string, body: string, parent: string) => ((await drive.uploadBinaryToDrive(name, mkBytes(body), "application/pdf", parent)) as { id: string }).id
    const fEin = await up(`ZZ T37 EIN Letter ${tag}.pdf`, "ein", co.id)
    const fRet = await up(`ZZ T37 2024 Return ${tag}.pdf`, "return", y24.id)
    const fDupA = await up(`ZZ T37 Articles ${tag}.pdf`, "same-bytes", co.id)
    const fDupB = await up(`ZZ T37 Articles copy ${tag}.pdf`, "same-bytes", root.id) // exact duplicate content, top of the folder
    const acct = (await q("insert into accounts (company_name, status, account_type, drive_folder_id) values ($1,'Closed','Client',$2) returning id", [`ZZ T37 Reactivation LLC ${tag}`, root.id]))[0].id as string
    made.accounts.push(acct)
    const mkRow = async (driveId: string, name: string, type: string, cat: number, catName: string, year: number | null) =>
      (await q(`insert into documents (drive_file_id, file_name, account_id, account_name, category, category_name, document_type_name, tax_year, portal_visible, status, created_at)
                values ($1,$2,$3,'ZZ T37',$4,$5,$6,$7,false,'classified', now() - interval '60 days') returning id`, [driveId, name, acct, cat, catName, type, year]))[0].id as string
    const rEin = await mkRow(fEin, `ZZ T37 EIN Letter ${tag}.pdf`, "EIN Letter (IRS)", 1, "Company", null)
    const rRet = await mkRow(fRet, `ZZ T37 2024 Return ${tag}.pdf`, "Form 1120", 3, "Tax", 2024)
    await q("insert into tax_returns (account_id, company_name, return_type, tax_year, deadline) values ($1, 'ZZ T37', 'SMLLC', 2024, '2025-04-15')", [acct])
    ck("0 the company starts Closed, on Drive, no storage", (await companyDocState(acct)) === "drive" && (await q("select 1 from store_owners where account_id=$1", [acct])).length === 0)

    // ───────────────────────── the reactivation
    console.log("\n1. Closed → Active leaves the event; the batch brings the documents back")
    await q("update accounts set status='Active' where id=$1", [acct])
    const ev = await q("select id, old_status, new_status from account_status_events where account_id=$1 and created_at >= $2", [acct, marker])
    ck("1a the trigger recorded Closed → Active", ev.length === 1 && ev[0].old_status === "Closed" && ev[0].new_status === "Active", ev)
    let r = await runReactivationBatch({ budgetMs: 230_000 })
    for (let i = 0; i < 6 && r.running > 0; i++) r = await runReactivationBatch({ budgetMs: 230_000 }) // a company larger than one run resumes
    ck("1b the batch finished the company", r.enabled && r.done >= 1 && r.running === 0, r)
    const state = (await q("select content from system_docs where slug=$1", [REACTIVATION_SLUG]))[0]?.content as string
    const item = (JSON.parse(state).items as Array<{ accountId: string; status: string; notes: string[] }>).find((i) => i.accountId === acct)
    ck("1c the item is done and says it posted a start and a done note", item?.status === "done" && item.notes.includes("start") && item.notes.includes("done"), item)

    ck("2a the company state is store", (await companyDocState(acct)) === "store")
    const owner = (await q("select id, study_only from store_owners where account_id=$1 and kind='company'", [acct]))[0]
    ck("2b exactly one company storage and it is live", !!owner && owner.study_only === false)
    const files = await q("select f.id, f.name, f.document_type, f.period_year from store_files f where f.owner_id=$1 and f.state='live'", [owner.id])
    ck("2c all four Drive files are in storage (an exact duplicate is NOT guessed away: both copies are kept, each with its own record)", files.length === 4, files.map((f) => f.name))
    ck("2d the 2024 return is in 3. Tax > 2024", (await q("select 1 from store_files f join store_folders d on d.id=f.folder_id join store_folders p on p.id=d.parent_id where f.owner_id=$1 and f.name like '%2024 Return%' and d.name='2024' and p.kind='tax'", [owner.id])).length === 1)
    const rows = await q("select id, drive_file_id, status, portal_visible, file_name from documents where account_id=$1", [acct])
    const pointing = rows.filter((x) => String(x.drive_file_id).startsWith("store:") && x.status !== "archived")
    ck("3a the EIN and Return records were re-pointed at storage", [rEin, rRet].every((id) => String(rows.find((x) => x.id === id)?.drive_file_id).startsWith("store:")), rows.map((x) => x.drive_file_id))
    const ptrs = pointing.map((x) => x.drive_file_id)
    ck("3b no stored file has two records", new Set(ptrs).size === ptrs.length, ptrs)
    ck("3c every live stored file has exactly one active record", files.every((f) => ptrs.filter((p) => p === `store:${f.id}`).length === 1), { files: files.length, ptrs: ptrs.length })
    ck("3d nothing is visible to the client", rows.every((x) => x.portal_visible === false))
    ck("3e the old Drive still has all four files (nothing deleted)", (await Promise.all([fEin, fRet, fDupA, fDupB].map((id) => drive.getDriveItemAnyDrive(id).then(() => true).catch(() => false)))).every(Boolean))
    ck("3f the 2024 tax-year folder exists (from the company's own tax record)", (await q("select 1 from store_folders d join store_folders p on p.id=d.parent_id where d.owner_id=$1 and d.name='2024' and p.kind='tax' and d.trashed_at is null", [owner.id])).length === 1)

    console.log("\n2. the Calendar")
    await processAccountStatusEvents({ budgetMs: 60_000 }) // 3b's own note for the status change
    const notes = await notesOf(acct)
    ck("4a staff-only notes were posted: the status note, the start and the done", notes.length === 3, notes.map((n) => n.slice(0, 90)))
    ck("4b the done note states counts and that nothing is shown to the client", notes.some((n) => /back in storage/.test(n) && /stored/.test(n) && /client sees none/.test(n)), notes)
    ck("4c no note went to a client (all are account-level system notes without a contact)", (await q("select count(*)::int n from portal_messages where account_id=$1 and message like '%kind=account_status_changed%' and created_at >= $2 and contact_id is not null", [acct, marker]))[0].n === 0)

    console.log("\n3. a second run adds nothing")
    const filesBefore = (await q("select count(*)::int n from store_files where owner_id=$1", [owner.id]))[0].n
    const rowsBefore = (await q("select count(*)::int n from documents where account_id=$1", [acct]))[0].n
    const notesBefore = (await notesOf(acct)).length
    const runsBefore = (await q("select count(*)::int n from store_import_runs where account_id=$1", [acct]))[0].n
    await runReactivationBatch({ budgetMs: 230_000 })
    ck("5a same files, same records, same notes, no new run", (await q("select count(*)::int n from store_files where owner_id=$1", [owner.id]))[0].n === filesBefore
      && (await q("select count(*)::int n from documents where account_id=$1", [acct]))[0].n === rowsBefore
      && (await notesOf(acct)).length === notesBefore
      && (await q("select count(*)::int n from store_import_runs where account_id=$1", [acct]))[0].n === runsBefore)

    console.log("\n4. reactivated twice: Closed again, then Active again — storage exists, nothing is copied again")
    await q("update accounts set status='Closed' where id=$1", [acct])
    await q("update accounts set status='Active' where id=$1", [acct])
    await runReactivationBatch({ budgetMs: 230_000 })
    const n2 = await notesOf(acct)
    ck("6a a note says it already has its storage", n2.some((n) => /already has its storage/.test(n)), n2.map((n) => n.slice(0, 80)))
    ck("6b no second copy run, same files", (await q("select count(*)::int n from store_import_runs where account_id=$1", [acct]))[0].n === runsBefore && (await q("select count(*)::int n from store_files where owner_id=$1", [owner.id]))[0].n === filesBefore)

    // ───────────────────────── company B: no Drive folder, no documents → an empty storage
    console.log("\n5. no Drive folder and no documents → an empty live storage")
    const b = (await q("insert into accounts (company_name, status, account_type) values ($1,'Cancelled','Client') returning id", [`ZZ T37 NoFolder LLC ${tag}`]))[0].id as string
    made.accounts.push(b)
    await q("update accounts set status='Active' where id=$1", [b])
    await runReactivationBatch({ budgetMs: 120_000 })
    ck("7a it has a live, empty storage", (await companyDocState(b)) === "store" && (await q("select count(*)::int n from store_files f join store_owners o on o.id=f.owner_id where o.account_id=$1", [b]))[0].n === 0)

    // ───────────────────────── company C: no Drive folder but documents → a person looks, nothing switched
    console.log("\n6. no Drive folder but CRM documents → stops and asks a person; nothing is switched")
    const c = (await q("insert into accounts (company_name, status, account_type) values ($1,'Closed','Client') returning id", [`ZZ T37 DocsNoFolder LLC ${tag}`]))[0].id as string
    made.accounts.push(c)
    await mkRow("0123456789abcdefghij", "orphan.pdf", "EIN Letter (IRS)", 1, "Company", null).then((id) => q("update documents set account_id=$2 where id=$1", [id, c]))
    await q("update accounts set status='Active' where id=$1", [c])
    await runReactivationBatch({ budgetMs: 120_000 })
    const nc = await notesOf(c)
    ck("8a no storage was made and the note asks a person to look", (await companyDocState(c)) === "drive" && nc.some((n) => /person has to look/.test(n)), nc.map((n) => n.slice(0, 100)))

    // ───────────────────────── company D: an EMPTY Drive folder
    console.log("\n7. an empty Drive folder → copied (nothing) and switched, empty live storage")
    const emptyRoot = await drive.createFolder(TEST_DRIVE, `ZZ T37 empty ${tag}`)
    made.folders.push(emptyRoot.id)
    const d = (await q("insert into accounts (company_name, status, account_type, drive_folder_id) values ($1,'Closed','Client',$2) returning id", [`ZZ T37 EmptyFolder LLC ${tag}`, emptyRoot.id]))[0].id as string
    made.accounts.push(d)
    await q("update accounts set status='Active' where id=$1", [d])
    let r2 = await runReactivationBatch({ budgetMs: 230_000 })
    for (let i = 0; i < 4 && r2.running > 0; i++) r2 = await runReactivationBatch({ budgetMs: 230_000 })
    ck("9a it ends in storage, with no files", (await companyDocState(d)) === "store" && (await q("select count(*)::int n from store_files f join store_owners o on o.id=f.owner_id where o.account_id=$1", [d]))[0].n === 0, r2)

    // ───────────────────────── the other switches stay shut
    console.log("\n8. the owner's go-live button stays shut without STORE_GO_LIVE")
    const { runGoLive } = await import("../../../lib/crm-store/go-live-run")
    const refused = await runGoLive(acct, "00000000-0000-0000-0000-000000000000").then(() => false, () => true)
    ck("10a a manual go-live without STORE_GO_LIVE is still refused", refused)
    const noAuto = await runGoLive(acct, null).then(() => false, () => true)
    ck("10b a go-live with no person and no automatic flag is refused", noAuto)
  } finally {
    for (const id of made.accounts) {
      await q("delete from portal_messages where account_id=$1 and message like '%kind=account_status_changed%' and created_at >= $2", [id, marker]).catch(() => undefined)
      await q("delete from account_status_events where account_id=$1", [id]).catch(() => undefined)
      const owners = (await q("select id from store_owners where account_id=$1", [id]).catch(() => [])).map((o) => o.id as string)
      await q("delete from store_import_runs where account_id=$1", [id]).catch(() => undefined)
      await q("delete from documents where account_id=$1", [id]).catch(() => undefined)
      await q("delete from tax_returns where account_id=$1", [id]).catch(() => undefined)
      // storage rows have rules against deletion: mark the test storages trashed-out of the way instead of fighting them
      for (const o of owners) await q("update store_files set state='trashed' where owner_id=$1 and state='live'", [o]).catch(() => undefined)
      await q("update accounts set status='Closed', drive_folder_id=null where id=$1", [id]).catch(() => undefined)
    }
    for (const f of made.folders) await drive.trashFile(f).catch(() => undefined)
    if (savedState) await q("update system_docs set content=$2 where slug=$1", [REACTIVATION_SLUG, savedState]).catch(() => undefined)
    else await q("delete from system_docs where slug=$1", [REACTIVATION_SLUG]).catch(() => undefined)
    await db.end()
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
