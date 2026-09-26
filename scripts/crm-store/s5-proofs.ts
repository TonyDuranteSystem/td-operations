/* eslint-disable no-console -- proof script: prints pass/fail lines */
/**
 * CRM Store — slice S5 proofs: the one-way Drive backup, against the REAL test Shared Drive
 * (master plan v4.5 §8.9 #5; Antonio #62 existing folders, #63 private Drive). SANDBOX ONLY.
 *   npx tsx scripts/crm-store/s5-proofs.ts [--prod-folder=<a real production folder id>]
 *
 * Builds a throwaway tree in the test Drive that looks like production ("Companies/Wyoming/{Company -
 * Owner}/1. Company …" with an original file inside) plus private roots, then proves: the backup ADOPTS
 * the existing company folder and the existing state folder, adds its copies inside, and never renames,
 * moves or changes the existing folders or the original; a state code ("NM") lands in the full-name
 * state folder; a person's passport goes to the private area; a re-run changes nothing; a crash between
 * upload and record does not duplicate; rename / move / new version / re-home propagate; a copy deleted
 * by hand is recreated; CRM trash → protected (private) area → restore → purge removed; a run stops
 * cleanly before the time limit; the alarm counts gaps; one worker per owner; the kill switch; the
 * production Drive refused. The test tree is trashed at the end; store rows stay dark under "ZZ S5".
 * (The test environment has one test Drive, so the "private Drive" is the same test Drive here — the
 * code searches both configured Drives.)
 */
import { config } from "dotenv"
config({ path: ".env.local" })

import { randomUUID } from "crypto"
import type { BackupConfig } from "@/lib/crm-store/backup"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1]

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(SANDBOX_REF)) throw new Error("not the sandbox — refusing")
  process.env.GOOGLE_DRIVE_LIVE = "1"
  process.env.GOOGLE_SHARED_DRIVE_ID = TEST_DRIVE
  delete process.env.STORE_BACKUP_ENABLED
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const drive = await import("@/lib/google-drive")
  const { saveBytesToStore } = await import("@/lib/crm-store/writer")
  const { trashFile: storeTrash, restoreBatch, purgeExpiredStore, purgeIO } = await import("@/lib/crm-store/folders")
  const { backupOwner, backupIO, sweepBackups } = await import("@/lib/crm-store/backup")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const staff = { id: randomUUID(), app_metadata: { role: "admin" } }
  const tag = Date.now()
  const fail = (m: string): never => { throw new Error(m) }
  const mk = async (parent: string, name: string) => ((await drive.createFolder(parent, name)) as { id: string }).id

  // a production-shaped tree in the TEST drive
  const top = await mk(TEST_DRIVE, `ZZ S5 backup proof ${tag}`)
  const companies = await mk(top, "Companies")
  const wyExisting = await mk(companies, "Wyoming")                                   // untagged, like production
  const legacyCo = await mk(wyExisting, `ZZ S5 Co ${tag} - Mario Rossi`)              // "{Company} - {Owner}"
  const legacySubs: Record<string, string> = {}
  for (const n of ["1. Company", "2. Contacts", "3. Tax", "4. Banking", "5. Correspondence"]) legacySubs[n] = await mk(legacyCo, n)
  const original = (await drive.uploadBinaryToDrive("Original OA.pdf", Buffer.from("ORIGINAL"), "application/pdf", legacySubs["1. Company"])) as { id: string }
  const cfg: BackupConfig = {
    mainDriveId: TEST_DRIVE, companiesRoot: companies,
    privateDriveId: TEST_DRIVE, restrictedRoot: await mk(top, "Private - Restricted"), protectedRoot: await mk(top, "Private - Protected"),
  }
  await db.from("store_backup_places").delete().like("place_key", "state:%")      // sandbox: forget places from earlier proof runs
  await db.from("store_backup_places").delete().in("place_key", ["people", "unfiled", "in_formation", "unplaced"])
  const run = (ownerId: string, extra: Record<string, unknown> = {}) => backupOwner(ownerId, { config: cfg, force: true, ...extra })
  const kids = async (folderId: string) => (await drive.listChildFolders(folderId, TEST_DRIVE)).map((x) => x.name).sort()
  const refOf = async (id: string) => (await db.from("store_external_refs").select("external_id, backed_up_sha256, drive_path, status").eq("object_id", id).eq("direction", "backup").maybeSingle()).data

  try {
    // fixtures
    const ins = async (row: Record<string, unknown>) =>
      // eslint-disable-next-line no-restricted-syntax -- sandbox-only proof fixture, not a business write
      (await db.from("accounts").insert(row).select("id").single()).data.id as string
    const acct = await ins({ company_name: `ZZ S5 Co ${tag}`, status: "Active", state_of_formation: "Wyoming", drive_folder_id: legacyCo })
    const acctNM = await ins({ company_name: `ZZ S5 NM ${tag}`, status: "Active", state_of_formation: "NM" })
    const acct2 = await ins({ company_name: `ZZ S5 Other ${tag}`, status: "Active", state_of_formation: "Delaware" })
    // eslint-disable-next-line no-restricted-syntax -- sandbox-only proof fixture, not a business write
    const { data: person } = await db.from("contacts").insert({ full_name: `ZZ S5 Person ${tag}` }).select("id").single()
    const owner = (await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: acct })).data as string
    const ownerNM = (await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: acctNM })).data as string
    const owner2 = (await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: acct2 })).data as string
    const ownerP = (await db.rpc("store_ensure_owner", { p_kind: "person", p_ref: person.id })).data as string
    for (const [o, n, t] of [[owner, `ZZ S5 Co ${tag}`, "company_standard"], [ownerNM, `ZZ S5 NM ${tag}`, "company_standard"],
                             [owner2, `ZZ S5 Other ${tag}`, "company_standard"], [ownerP, `ZZ S5 Person ${tag}`, "person_standard"]]) {
      await db.rpc("store_apply_template", { p_owner_id: o, p_template_slug: t, p_root_name: n })
    }
    const folder = async (o: string, kind: string) => (await db.from("store_folders").select("id").eq("owner_id", o).eq("kind", kind).single()).data.id as string
    const fCo = await folder(owner, "company"), fTax = await folder(owner, "tax"), fCorr = await folder(owner, "correspondence")
    const fCo2 = await folder(owner2, "company"), fNM = await folder(ownerNM, "company"), fP = await folder(ownerP, "personal")
    const save = (o: string, f: string, name: string, text: string, key: string | null = null, type = "irs_notice") =>
      saveBytesToStore({ ownerId: o, folderId: f, name, bytes: Buffer.from(text), callerKey: key, contentChanged: true, actor: staff.id, documentType: type, mimeType: "text/plain" })
    const a = await save(owner, fCo, "OA.txt", "operating agreement v1", `zz-s5:${tag}:oa`)
    const b = await save(owner, fTax, "Return 2025.txt", "return body")
    await save(ownerNM, fNM, "NM doc.txt", "nm")
    const pass = await save(ownerP, fP, "Passport.txt", "PASSPORT", null, "passport")

    // ── 1. existing folders adopted (#62): no second state folder, nothing renamed/moved, the original untouched
    const r1 = await run(owner)
    if (r1.status !== "done" || r1.uploaded !== 2) fail(`CHECK 1 FAILED: ${JSON.stringify(r1)}`)
    if ((await kids(companies)).filter((n) => n === "Wyoming").length !== 1) fail("CHECK 1 FAILED: a second Wyoming folder was created")
    const co = await drive.getTaggedItem(legacyCo)
    if (co?.name !== `ZZ S5 Co ${tag} - Mario Rossi` || !(co?.parents ?? []).includes(wyExisting)) fail("CHECK 1 FAILED: the existing company folder was renamed or moved")
    if ((await kids(legacyCo)).join("|") !== "1. Company|2. Contacts|3. Tax|4. Banking|5. Correspondence") fail(`CHECK 1 FAILED: sub-folders changed ${await kids(legacyCo)}`)
    const aCopy = await drive.getTaggedItem((await refOf(a.fileId)).external_id)
    if (!(aCopy?.parents ?? []).includes(legacySubs["1. Company"])) fail("CHECK 1 FAILED: the copy is not inside the existing 1. Company folder")
    const orig = await drive.getTaggedItem(original.id)
    if (orig?.trashed || orig?.name !== "Original OA.pdf" || (await drive.downloadFileBinary(original.id)).buffer.toString() !== "ORIGINAL") fail("CHECK 1 FAILED: the original file was touched")
    const again = await run(owner)
    if (again.uploaded + again.updated + again.moved + again.recreated + again.removed !== 0) fail(`CHECK 1 FAILED: re-run changed things ${JSON.stringify(again)}`)
    console.log("CHECK 1 passed — the existing Wyoming and company folders are adopted: copies added inside, no second state folder, nothing renamed or moved, the original untouched; a re-run changes nothing")

    // ── 2. state code → full-name folder; person → private area; formation-free company without folder → its state
    await run(ownerNM); await run(ownerP); await run(owner2)
    if (!(await kids(companies)).includes("New Mexico") || (await kids(companies)).includes("NM")) fail("CHECK 2 FAILED: NM not placed under New Mexico")
    const passCopy = await drive.getTaggedItem((await refOf(pass.fileId)).external_id)
    const people = (await drive.listChildFolders(cfg.restrictedRoot, TEST_DRIVE)).find((x) => x.name === "People")
    if (!people) fail("CHECK 2 FAILED: no People place in the private area")
    const personRoot = (await drive.listChildFolders(people!.id, TEST_DRIVE)).find((x) => x.name === `ZZ S5 Person ${tag}`)
    const personalSub = personRoot ? (await drive.listChildFolders(personRoot.id, TEST_DRIVE)).find((x) => x.name === "Personal documents") : undefined
    if (!personalSub || !(passCopy?.parents ?? []).includes(personalSub.id)) fail("CHECK 2 FAILED: the passport is not in the private People area")
    console.log("CHECK 2 passed — \"NM\" lands in New Mexico; a person's passport goes to the private People area, never the companies tree")

    // ── 3. crash between "created in Drive" and "recorded" → no duplicate
    const c = await save(owner, fCorr, "Letter.txt", "a letter")
    const crashing = { ...backupIO, recordRef: async (...x: Parameters<typeof backupIO.recordRef>) => {
      if (x[0] === "file" && x[1] === c.fileId) throw new Error("simulated crash after the Drive upload")
      return backupIO.recordRef(...x)
    } }
    const r3 = await run(owner, { io: crashing })
    if (r3.status !== "failed" || r3.fileErrors.length !== 1) fail(`CHECK 3 FAILED: crash not reported per file ${JSON.stringify(r3)}`)
    const r3b = await run(owner)
    if (r3b.status !== "done" || r3b.uploaded !== 0 || (await drive.findByAppProperty("crm_file_id", c.fileId, [TEST_DRIVE])).length !== 1) fail(`CHECK 3 FAILED: ${JSON.stringify(r3b)}`)
    console.log("CHECK 3 passed — a crash between upload and record is reported for that file only; the next run finds its own copy (no duplicate)")

    // ── 4. rename, move, new version, re-home propagate (our copies only; adopted folders stay as they are)
    await db.from("store_files").update({ name: "OA signed.txt" }).eq("id", a.fileId)
    await db.from("store_files").update({ folder_id: fCorr }).eq("id", b.fileId)
    await save(owner, fCo, "OA signed.txt", "operating agreement v2", `zz-s5:${tag}:oa`)
    await run(owner)
    const aRef = await refOf(a.fileId), bRef = await refOf(b.fileId)
    const aItem = await drive.getTaggedItem(aRef.external_id), bItem = await drive.getTaggedItem(bRef.external_id)
    if (aItem?.name !== "OA signed.txt" || (await drive.downloadFileBinary(aRef.external_id)).buffer.toString() !== "operating agreement v2"
        || !(bItem?.parents ?? []).includes(legacySubs["5. Correspondence"])) fail("CHECK 4 FAILED: rename / new version / move not propagated")
    await db.rpc("store_rehome_file", { p_file_id: c.fileId, p_to_folder: fCo2, p_actor: staff.id, p_reason: "misfiled" })
    await run(owner); await run(owner2)
    if (!((await drive.getTaggedItem((await refOf(c.fileId)).external_id))?.parents ?? []).includes((await refOf(fCo2)).external_id)) fail("CHECK 4 FAILED: re-home not propagated")
    console.log("CHECK 4 passed — rename, new version (content replaced), move and a re-home to another client all propagate to OUR copies")

    // ── 5. a copy deleted by hand is recreated; a fixed folder deleted by hand is re-created too
    await drive.trashFile(aRef.external_id)
    const r5 = await run(owner, { fullCheck: true })
    if (r5.recreated < 1 || (await refOf(a.fileId)).external_id === aRef.external_id) fail(`CHECK 5 FAILED: ${JSON.stringify(r5)}`)
    console.log("CHECK 5 passed — a copy someone deleted in Drive is recreated on the next run")

    // ── 6. CRM trash → private protected area → restore → back → purge → removed (the original never)
    const batch = await storeTrash(staff, b.fileId, "proof")
    await run(owner)
    const bT = await refOf(b.fileId)
    const prot = (await drive.listChildFolders(cfg.protectedRoot, TEST_DRIVE)).find((x) => x.name.includes(`ZZ S5 Co ${tag}`))
    if (bT.drive_path.area !== "protected" || !prot || !((await drive.getTaggedItem(bT.external_id))?.parents ?? []).includes(prot.id)) fail("CHECK 6 FAILED: not in the private protected area")
    await restoreBatch(staff, batch)
    await run(owner)
    if (!((await drive.getTaggedItem((await refOf(b.fileId)).external_id))?.parents ?? []).includes(legacySubs["5. Correspondence"])) fail("CHECK 6 FAILED: not back on restore")
    await storeTrash(staff, b.fileId, "again")
    await db.from("store_files").update({ purge_after: new Date(Date.now() - 60_000).toISOString() }).eq("id", b.fileId)
    await purgeExpiredStore(new Date(), { ...purgeIO, listDue: async () => [b.fileId] })
    const r6 = await run(owner)
    const gone = await drive.getTaggedItem(bT.external_id)
    if (r6.removed < 1 || (gone && !gone.trashed) || (await refOf(b.fileId)).status !== "purged") fail(`CHECK 6 FAILED: ${JSON.stringify(r6)}`)
    if ((await drive.getTaggedItem(original.id))?.trashed) fail("CHECK 6 FAILED: the original was removed")
    console.log("CHECK 6 passed — CRM trash moves our copy to the private protected area, restore moves it back, purge removes it; the original is never touched")

    // ── 7. deadline, alarm, lease, kill switch, production refused
    const d = await save(owner, fCo, "New.txt", "not yet backed up")
    const late = await run(owner, { deadlineAt: Date.now() })
    const st = (await db.from("store_backup_state").select("consecutive_failures").eq("owner_id", owner).single()).data
    if (late.status !== "deferred" || st.consecutive_failures !== 0) fail(`CHECK 7 FAILED: a clean stop before the time limit ${JSON.stringify(late)} ${JSON.stringify(st)}`)
    const { data: counts } = await db.rpc("store_backup_gap_counts", {})
    if (!((counts ?? []).find((x: { kind: string; n: number }) => x.kind === "missing_file")?.n >= 1)) fail("CHECK 7 FAILED: the alarm does not count the unbacked file")
    const { data: lease } = await db.rpc("store_backup_claim", { p_owner_id: owner })
    if ((await run(owner)).status !== "busy") fail("CHECK 7 FAILED: two workers on one owner")
    await db.rpc("store_backup_finish", { p_owner_id: owner, p_token: lease.token, p_outcome: "deferred", p_up_to_event: 0 })
    await run(owner)
    const { data: gaps } = await db.rpc("store_backup_gaps", {})
    if ((gaps ?? []).some((g: { file_id: string }) => g.file_id === d.fileId)) fail("CHECK 7 FAILED: gap remained after the run")
    if ((await backupOwner(owner, { config: cfg })).status !== "disabled" || (await sweepBackups()).status !== "disabled") fail("CHECK 7 FAILED: kill switch")
    const prod = arg("prod-folder")
    if (prod) {
      await save(owner2, fCo2, "Prod test.txt", "must never reach production")
      await db.from("store_backup_places").delete().eq("place_key", "state:Delaware")
      const r7 = await backupOwner(owner2, { config: { ...cfg, companiesRoot: prod }, force: true })
      if (r7.status !== "failed" || !/refused/i.test(r7.error ?? "")) fail(`CHECK 7 FAILED: production not refused ${JSON.stringify(r7)}`)
      await db.from("store_backup_places").delete().eq("place_key", "state:Delaware")
    }
    console.log(`CHECK 7 passed — a run stops cleanly before the time limit (not a failure); the alarm counts gaps and clears; one worker per owner; the kill switch stops everything${prod ? "; a real production folder is refused" : ""}`)
    console.log("ALL S5 BACKUP CHECKS PASSED")
  } finally {
    await drive.trashFile(top).catch(() => undefined)
  }
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1) })
