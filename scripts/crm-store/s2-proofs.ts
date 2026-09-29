/* eslint-disable no-console -- proof script: prints pass/fail lines */
/**
 * CRM Store — slice S2 storage-level proofs (master plan v4.4 §8.9 slice 2). SANDBOX ONLY.
 *   npx tsx scripts/crm-store/s2-proofs.ts [--big-mb=1024] [--prod-folder=<a real production client folder id>]
 *
 * 1. an 18 MB server save: created → same bytes again = "unchanged" and the duplicate object removed
 * 2. a large file uploaded resumably (TUS) into a staging slot, then registered (streamed hash,
 *    moved into crm-store): proves the size limit and the large-file path
 * 3. the production-Drive guard with REAL Drive calls: refused with no test drive; refused on a real
 *    production client folder even with the test drive set; allowed (and cleaned up) inside the test drive
 * Every fixture it creates is removed at the end (rows under a throwaway owner are left dark: no client).
 */
import { config } from "dotenv"
config({ path: ".env.local" })

import { randomBytes, randomUUID } from "crypto"
import * as tus from "tus-js-client"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!url.includes(SANDBOX_REF)) throw new Error("not the sandbox — refusing")
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { saveBytesToStore, createUploadIntent, registerNow, STORE_BUCKET } = await import("@/lib/crm-store/writer")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // throwaway owner (a person record created for the proof)
  // eslint-disable-next-line no-restricted-syntax -- sandbox-only proof fixture, not a business write
  const { data: c } = await db.from("contacts").insert({ full_name: "ZZ S2 Storage Proof" }).select("id").single()
  const { data: ownerId } = await db.rpc("store_ensure_owner", { p_kind: "person", p_ref: c.id })
  await db.rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: "person_standard", p_root_name: "ZZ S2 Storage Proof" })
  const { data: folder } = await db.from("store_folders").select("id").eq("owner_id", ownerId).eq("kind", "personal").single()
  const actor: string = randomUUID() // proof actor id (slots are bound to it)

  // ── 1. 18 MB server save
  const bytes18 = randomBytes(18 * 1024 * 1024)
  const t0 = Date.now()
  const r1 = await saveBytesToStore({ ownerId, folderId: folder.id, name: "ZZ 18MB.bin", bytes: bytes18, callerKey: `zz-s2-proof:${c.id}:18mb`, contentChanged: true, actor })
  const r1b = await saveBytesToStore({ ownerId, folderId: folder.id, name: "ZZ 18MB.bin", bytes: bytes18, callerKey: `zz-s2-proof:${c.id}:18mb`, contentChanged: true, actor })
  const { data: objs } = await db.storage.from(STORE_BUCKET).list(ownerId, { limit: 100 })
  if (r1.status !== "created" || r1b.status !== "unchanged" || (objs ?? []).length !== 1) {
    throw new Error(`CHECK 1 FAILED: ${r1.status} / ${r1b.status} / ${(objs ?? []).length} objects`)
  }
  console.log(`CHECK 1 passed — 18 MB saved in ${Date.now() - t0} ms incl. retry; retry "unchanged"; exactly one object kept`)

  // ── 1b. two saves of the same identity at the same moment → ONE file (created + versioned/unchanged), never two
  const key = `zz-s2-proof:${c.id}:concurrent`
  const [ca, cb] = await Promise.all([
    saveBytesToStore({ ownerId, folderId: folder.id, name: "ZZ concurrent.bin", bytes: randomBytes(1024), callerKey: key, contentChanged: true, actor }),
    saveBytesToStore({ ownerId, folderId: folder.id, name: "ZZ concurrent.bin", bytes: randomBytes(1024), callerKey: key, contentChanged: true, actor }),
  ])
  const { data: same } = await db.from("store_files").select("id").eq("caller_key", key)
  if ((same ?? []).length !== 1 || ca.fileId !== cb.fileId) throw new Error(`CHECK 1b FAILED: ${ca.status}/${cb.status}, ${(same ?? []).length} files`)
  console.log(`CHECK 1b passed — two simultaneous saves of one identity: ${ca.status} + ${cb.status}, one file`)

  // ── 2. large resumable upload into a staging slot, then registered
  const bigMb = Number(arg("big-mb") ?? "0")
  if (bigMb > 0) {
    const intent = await createUploadIntent({ ownerId, folderId: folder.id, fileName: `ZZ ${bigMb}MB.bin`, actor, actorRole: "admin" })
    const big = randomBytes(bigMb * 1024 * 1024)
    const t1 = Date.now()
    await new Promise<void>((resolve, reject) => {
      const up = new tus.Upload(big, {
        endpoint: `${url}/storage/v1/upload/resumable`,
        retryDelays: [0, 3000, 5000, 10000],
        headers: { apikey: String(process.env.SUPABASE_SERVICE_ROLE_KEY), "x-upsert": "false" }, // new-format secret key: apikey header, no Bearer JWT
        uploadDataDuringCreation: true,
        chunkSize: 6 * 1024 * 1024,
        metadata: { bucketName: intent.bucket, objectName: intent.stagingPath, contentType: "application/octet-stream" },
        onError: reject,
        onSuccess: () => resolve(),
      })
      up.start()
    })
    const tUp = Date.now() - t1
    const t2 = Date.now()
    const r2 = await registerNow({ intentId: intent.intentId, actor })
    if (r2.status !== "created") throw new Error(`CHECK 2 FAILED: ${r2.status}`)
    const { data: v } = await db.from("store_file_versions").select("size_bytes").eq("id", r2.versionId).single()
    if (Number(v.size_bytes) !== big.length) throw new Error(`CHECK 2 FAILED: size ${v.size_bytes} vs ${big.length}`)
    console.log(`CHECK 2 passed — ${bigMb} MB resumable upload in ${tUp} ms; registered (streamed hash + move) in ${Date.now() - t2} ms`)
  } else {
    console.log("CHECK 2 skipped (pass --big-mb=N)")
  }

  // ── 3. production-Drive guard, real Drive calls
  const prodFolder = arg("prod-folder")
  process.env.GOOGLE_DRIVE_LIVE = "1"
  const drive = await import("@/lib/google-drive")
  delete process.env.GOOGLE_SHARED_DRIVE_ID
  let refusedNoTestDrive = false
  try { await drive.createFolder(TEST_DRIVE, "zz-s2-guard-should-not-exist") } catch (e) { refusedNoTestDrive = /refused/.test(String(e)) }
  if (!refusedNoTestDrive) throw new Error("CHECK 3 FAILED: write allowed with no test drive configured")
  process.env.GOOGLE_SHARED_DRIVE_ID = TEST_DRIVE
  if (prodFolder) {
    let refusedProd = false
    try { await drive.createFolder(prodFolder, "zz-s2-guard-should-not-exist") } catch (e) { refusedProd = /not inside the test Shared Drive/.test(String(e)) }
    if (!refusedProd) throw new Error("CHECK 3 FAILED: sandbox write into a REAL production folder was allowed")
  }
  const made = (await drive.createFolder(TEST_DRIVE, `zz-s2-guard-proof-${Date.now()}`)) as { id: string }
  await drive.trashFile(made.id)
  console.log(`CHECK 3 passed — refused with no test drive; ${prodFolder ? "refused on a real production client folder; " : ""}allowed inside the test drive (created + trashed)`)

  // cleanup fixtures: remove stored objects (rows stay dark under the throwaway person)
  const { data: all } = await db.storage.from(STORE_BUCKET).list(ownerId, { limit: 100 })
  if (all?.length) await db.storage.from(STORE_BUCKET).remove(all.map((o: { name: string }) => `${ownerId}/${o.name}`))
  console.log("ALL S2 STORAGE CHECKS PASSED")
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1) })
