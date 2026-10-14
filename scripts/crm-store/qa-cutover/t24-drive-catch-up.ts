/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ T24" rows) */
/**
 * Drive → storage CATCH-UP (dev job ad09ea91) — SANDBOX ONLY, real files in the sandbox TEST Shared Drive.
 * A switched test company gets records made AFTER its approved copy; the catch-up brings in exactly those, changes nothing else,
 * is byte-checked, never switches the company, and its undo puts every record back on Drive.
 * Run: STORE_GO_LIVE=1 GOOGLE_DRIVE_LIVE=1 npx tsx scripts/crm-store/qa-cutover/t24-drive-catch-up.ts
 */
import { config } from "dotenv"
import { Client } from "pg"
import { createHash } from "crypto"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const ck = (m: string, c: unknown, x?: unknown) => check(m, !!c, x === undefined ? "" : typeof x === "string" ? x : JSON.stringify(x).slice(0, 240))
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"
const UXIO = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  if (process.env.STORE_GO_LIVE !== "1") throw new Error("set STORE_GO_LIVE=1")
  process.env.SANDBOX_MODE = "1"
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const tag = Date.now()
  const { uploadBinaryToDrive } = await import("../../../lib/google-drive")
  const { planCatchUp, runCatchUp, undoCatchUp, listCatchUp } = await import("../../../lib/crm-store/catch-up")
  const { companyDocState } = await import("../../../lib/crm-store/switched-drive-guard")
  const actor = (await q("select id from auth.users limit 1"))[0]?.id as string

  const owner = (await q("select id, study_only from store_owners where account_id=$1 and kind='company' and study_only=false limit 1", [UXIO]))[0]
  if (!owner) throw new Error("the test company has no live storage")
  // an approved copy that started long ago
  const copy = (await q("insert into store_import_runs (account_id, owner_id, status, mode, started_at, finished_at) values ($1,$2,'done','copy', now() - interval '30 days', now() - interval '29 days') returning id", [UXIO, owner.id]))[0]

  const mkFile = async (name: string, body: string) => {
    const bytes = Buffer.from(`%PDF-1.4\n% ZZ T24 ${tag} ${body}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`)
    const f = (await uploadBinaryToDrive(name, bytes, "application/pdf", TEST_DRIVE)) as { id: string }
    return { id: f.id, md5: createHash("md5").update(bytes).digest("hex") }
  }
  const mkRow = async (driveId: string, name: string, type: string | null, visible: boolean, extra: { createdAgo?: string; stage?: string | null } = {}) =>
    (await q(`insert into documents (drive_file_id, file_name, account_id, account_name, category, category_name, document_type_name, portal_visible, status, flow_stage, created_at)
              values ($1,$2,$3,'Uxio Test LLC',3,'Tax',$4,$5,'classified',$6, now() - $7::interval) returning id`, [driveId, name, UXIO, type, visible, extra.stage ?? null, extra.createdAgo ?? "1 day"]))[0].id as string

  console.log("\nfixtures: real files in the test Drive + CRM records")
  const fTyped = await mkFile(`ZZ T24 typed visible ${tag}.pdf`, "typed")
  const fHidden = await mkFile(`ZZ T24 hidden ${tag}.pdf`, "hidden")
  const fUntyped = await mkFile(`ZZ T24 untyped visible ${tag}.pdf`, "untyped")
  const fOld = await mkFile(`ZZ T24 older than copy ${tag}.pdf`, "old")
  const fStage = await mkFile(`ZZ T24 workspace ${tag}.pdf`, "stage")
  const fTax = await mkFile(`ZZ T24 2025 signed return ${tag}.pdf`, "tax")
  const rTax = await q(`insert into documents (drive_file_id, file_name, account_id, account_name, category, category_name, document_type_name, portal_visible, status, created_at)
              values ($1,$2,$3,'Uxio Test LLC',5,'Correspondence','Form 1120',true,'classified', now() - interval '1 day') returning id`, [fTax.id, `ZZ T24 2025 signed return ${tag}.pdf`, UXIO]).then((r) => r[0].id as string)
  const fPass = await mkFile(`ZZ T24 passport ${tag}.pdf`, "passport")
  const rPass = await q(`insert into documents (drive_file_id, file_name, account_id, account_name, category, category_name, document_type_name, portal_visible, status, created_at)
              values ($1,$2,$3,'Uxio Test LLC',2,'Contacts','Passport',false,'classified', now() - interval '1 day') returning id`, [fPass.id, `ZZ T24 passport ${tag}.pdf`, UXIO]).then((r) => r[0].id as string)
  const rTyped = await mkRow(fTyped.id, `ZZ T24 typed visible ${tag}.pdf`, "EIN Letter (IRS)", true)
  const rHidden = await mkRow(fHidden.id, `ZZ T24 hidden ${tag}.pdf`, "IRS Fax", false)
  const rUntyped = await mkRow(fUntyped.id, `ZZ T24 untyped visible ${tag}.pdf`, null, true)
  const fShared = await mkFile(`ZZ T24 shared ${tag}.pdf`, "shared")
  const rShareA = await mkRow(fShared.id, `ZZ T24 shared A ${tag}.pdf`, "EIN Letter (IRS)", true)
  const rDup = await mkRow(fShared.id, `ZZ T24 shared B ${tag}.pdf`, "EIN Letter (IRS)", true, { createdAgo: "12 hours" })
  const rOld = await mkRow(fOld.id, `ZZ T24 older than copy ${tag}.pdf`, "IRS Fax", false, { createdAgo: "60 days" })
  const rStage = await mkRow(fStage.id, `ZZ T24 workspace ${tag}.pdf`, "IRS Fax", false, { stage: "EIN Received" })
  const rPseudo = await mkRow(`ss4-live:${tag}00000`, `ZZ T24 pseudo ${tag}.pdf`, "SS-4", false)
  const snapshotOf = async (ids: string[]) => JSON.stringify(await q("select id, drive_file_id, drive_link, file_name, portal_visible, status, document_type_name, category, tax_year from documents where id = any($1) order by id", [ids]))
  const untouched = [rOld, rStage, rPseudo, rDup, rShareA, rPass]
  const untouchedBefore = await snapshotOf(untouched)
  const bothBefore = await snapshotOf([rTyped, rHidden, rUntyped])
  const peopleBefore = JSON.stringify(await q("select id, study_only from store_owners where kind='person' order by id"))
  const ownerBefore = JSON.stringify(await q("select id, study_only from store_owners where account_id=$1 and kind='company'", [UXIO]))

  try {
    console.log("\n1. the dry run")
    const plan = await planCatchUp(UXIO)
    const ids = plan.eligible.map((e) => e.id)
    console.log("      eligible:", plan.eligible.map((e) => e.name).join(" | ").slice(0, 300))
    ck("1a no blockers", plan.blockers.length === 0, plan.blockers.join("; "))
    ck("1b exactly the three records made after the copy are eligible", ids.includes(rTyped) && ids.includes(rHidden) && ids.includes(rUntyped) && !ids.includes(rOld) && !ids.includes(rStage) && !ids.includes(rPseudo), ids)
    ck("1b2 two records that share one Drive file are BOTH left alone (listed), not handled twice", !ids.includes(rDup) && !ids.includes(rShareA) && plan.skipped.some((x) => x.id === rDup && /shared/.test(x.reason)), ids)
    ck("1c every refusal says why", plan.skipped.filter((s) => [rOld, rStage, rPseudo].includes(s.id)).every((s) => s.reason.length > 5), plan.skipped)
    ck("1d the dry run changed nothing", (await snapshotOf([rTyped, rHidden, rUntyped])) === bothBefore && (await snapshotOf(untouched)) === untouchedBefore)
    ck("1e it shows in the list of companies with work", (await listCatchUp()).some((c) => c.accountId === UXIO))

    console.log("\n2. a changed plan is refused")
    const stale = await runCatchUp(UXIO, actor, { expectedPlanHash: "not-the-hash" })
    ck("2a refused, nothing locked, nothing changed", !stale.ok && stale.runId === null && (await snapshotOf([rTyped, rHidden, rUntyped])) === bothBefore, stale.message)

    console.log("\n3. the catch-up")
    const res = await runCatchUp(UXIO, actor, { expectedPlanHash: plan.planHash })
    console.log("      result:", res.message)
    for (const i of res.items) console.log(`      - ${i.outcome}: ${i.name.slice(0, 40)} — ${i.detail.slice(0, 100)}`)
    const byName = (n: string) => res.items.find((i) => i.name.includes(n))
    ck("3a the typed visible record was brought in", byName("typed visible")?.outcome === "brought_in", res.items)
    ck("3b the hidden record was brought in", byName("hidden")?.outcome === "brought_in", res.items)
    ck("3c the untyped record the client can see stays on Drive and is LISTED", byName("untyped visible")?.outcome === "kept_on_drive", res.items)
    const after = await q("select id, drive_file_id, portal_visible, document_type_name, status from documents where id = any($1)", [[rTyped, rHidden, rUntyped]])
    const get = (id: string) => after.find((r: { id: string }) => r.id === id)
    const taxRow = (await q("select drive_file_id from documents where id=$1", [rTax]))[0]
    const taxFile = (await q("select f.id, fo.kind, fo.name, (select p.kind from store_folders p where p.id=fo.parent_id) parent_kind from store_files f join store_folders fo on fo.id=f.folder_id where 'store:'||f.id = $1", [taxRow.drive_file_id]))[0]
    ck("3c1 a signed return the CRM filed under 'Correspondence' lands in TAX (the type's folder), in its year folder when one exists", taxFile && (taxFile.kind === "tax" || (taxFile.kind === "tax_year" && taxFile.parent_kind === "tax")), taxFile)
    const pass = (await q("select drive_file_id from documents where id=$1", [rPass]))[0]
    ck("3c2 the personal document stays on Drive (never filed by the catch-up) and no person storage was switched", pass.drive_file_id === fPass.id && byName("passport")?.outcome === "kept_on_drive" && JSON.stringify(await q("select id, study_only from store_owners where kind='person' order by id")) === peopleBefore, byName("passport"))
    ck("3c3 the records that share a Drive file were NOT touched", (await q("select drive_file_id from documents where id = any($1)", [[rDup, rShareA]])).every((r: { drive_file_id: string }) => r.drive_file_id === fShared.id))
    ck("3d the SAME records now point at the storage (no new records)", String(get(rTyped).drive_file_id).startsWith("store:") && String(get(rHidden).drive_file_id).startsWith("store:"), after)
    ck("3e the untyped record still opens from Drive", get(rUntyped).drive_file_id === fUntyped.id)
    ck("3f the client sees what they saw: typed visible stays visible, hidden stays hidden", get(rTyped).portal_visible === true && get(rHidden).portal_visible === false, after)
    ck("3g the older / workspace / internal records were not touched", (await snapshotOf(untouched)) === untouchedBefore)
    const sf = await q("select f.id, f.published from store_files f where 'store:' || f.id = any($1)", [[get(rTyped).drive_file_id, get(rHidden).drive_file_id]])
    ck("3h the stored copies exist (typed shown, hidden hidden)", sf.length === 2, sf)
    const { readStoreFile } = await import("../../../lib/crm-store/document-pointer")
    const bytes = await readStoreFile(String(get(rTyped).drive_file_id).slice(6))
    ck("3i the stored bytes are exactly Drive's (md5)", createHash("md5").update(bytes.bytes).digest("hex") === fTyped.md5)
    ck("3j the company was never switched or un-switched", JSON.stringify(await q("select id, study_only from store_owners where account_id=$1 and kind='company'", [UXIO])) === ownerBefore && (await companyDocState(UXIO)) === "store")
    const run = (await q("select status, mode, report from store_import_runs where id=$1", [res.runId]))[0]
    ck("3k the run is tagged catch-up, never go-live", run?.report?.catchUp === true && run?.report?.goLive !== true && ["done", "incomplete"].includes(run.status), run)
    const open = await q("select count(*)::int n from store_import_runs where account_id=$1 and status in ('scanning','moving','undoing')", [UXIO])
    ck("3l no lock is left open", open[0].n === 0)

    const { latestRunFor, movedAt, undoDriveImport } = await import("../../../lib/crm-store/drive-import")
    const lr = await latestRunFor(UXIO, "move")
    ck("3m the company page's 'latest move' is NOT the catch-up run", !lr || lr.id !== res.runId, lr?.id)
    const ma = await movedAt(UXIO)
    ck("3n 'moved at' ignores the catch-up run", !ma || ma.startedAt !== (await q("select started_at from store_import_runs where id=$1", [res.runId]))[0].started_at, ma)
    ck("3o the Move panel's undo refuses a catch-up run", await (async () => { try { await undoDriveImport(res.runId as string, actor); return false } catch { return true } })())
    const copiesBefore = (await q("select count(*)::int n from store_files where caller_key like $1", [`catch-up:${rUntyped}:%`]))[0].n
    console.log("\n4. run it again → nothing more to do")
    const again = await planCatchUp(UXIO)
    const res2 = await runCatchUp(UXIO, actor, { expectedPlanHash: again.planHash })
    const copiesAfter = (await q("select count(*)::int n from store_files where caller_key like $1", [`catch-up:${rUntyped}:%`]))[0].n
    ck("4b running it again makes NO second stored copy of the record kept on Drive", copiesBefore === 1 && copiesAfter === 1, { copiesBefore, copiesAfter })
    ck("4c nothing new was re-pointed the second time", res2.items.filter((i) => i.outcome === "brought_in").length === 0, res2.items.map((i) => i.outcome))
    ck("4a only the two records that STAY on Drive (untyped visible, personal) are still eligible", again.eligible.filter((e) => e.name.includes("ZZ T24")).map((e) => e.id).sort().join() === [rUntyped, rPass].sort().join(), again.eligible.map((e) => e.name))

    console.log("\n5. undo")
    const undo = await undoCatchUp(res.runId as string, actor)
    console.log("      undo:", JSON.stringify(undo))
    ck("5a every record is back on its Drive file, exactly as before", (await snapshotOf([rTyped, rHidden, rUntyped])) === bothBefore)
    ck("5b the company is still switched", (await companyDocState(UXIO)) === "store" && JSON.stringify(await q("select id, study_only from store_owners where account_id=$1 and kind='company'", [UXIO])) === ownerBefore)
    ck("5c the older / workspace / internal records are still untouched", (await snapshotOf(untouched)) === untouchedBefore)
    const trashed = (await q("select state from store_files where caller_key like $1", [`catch-up:${rTyped}:%`]))
    ck("5c2 the stored copies the catch-up made are in the trash after the undo (restorable), so a later run starts clean", trashed.length > 0 && trashed.every((t: { state: string }) => t.state === "trashed"), trashed)
    ck("5d the go-live undo refuses to touch a catch-up run", await (async () => { try { const { undoGoLive } = await import("../../../lib/crm-store/go-live-run"); await undoGoLive(res.runId as string, actor); return false } catch { return true } })())
  } finally {
    // clean up this run's fixtures
    await q("delete from documents where id = any($1)", [[rTyped, rHidden, rUntyped, rOld, rStage, rPseudo, rDup, rShareA, rPass, rTax]])
    await q("delete from store_import_runs where id=$1", [copy.id])
    await db.end()
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
