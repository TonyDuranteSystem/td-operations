/* eslint-disable no-console -- proof script: prints pass/fail lines */
/**
 * CRM Store — slice S4 storage-level proofs (master plan v4.5 §8.9 #4). SANDBOX ONLY.
 *   npx tsx scripts/crm-store/s4-proofs.ts
 *
 * 1. a REAL zip of a folder tree, streamed, for a member: the other member's passport is not in it,
 *    the folder structure and bytes are exact
 * 2. a REAL whole-folder upload: nested folders created, one bad path refused, the others uploaded and
 *    registered
 * 3. a REAL purge of a file whose 90 days have run out (its purge date is moved into the past for
 *    the proof — the purge itself only trusts the database clock): bytes leave the bucket, tombstone stays
 * Fixture rows stay dark under throwaway "ZZ S4" records (store rows can never be deleted by design).
 */
import { config } from "dotenv"
config({ path: ".env.local" })

import { randomUUID } from "crypto"
import { unzipSync, strFromU8 } from "fflate"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"

async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const r = s.getReader()
  for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value) }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(SANDBOX_REF)) throw new Error("not the sandbox — refusing")
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { saveBytesToStore, registerNow, STORE_BUCKET, STORE_STAGING_BUCKET } = await import("@/lib/crm-store/writer")
  const { folderZipListing, streamZip, startFolderUpload, trashFile, purgeExpiredStore, purgeIO } = await import("@/lib/crm-store/folders")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const staff = { id: randomUUID(), app_metadata: { role: "admin" } }
  const tag = Date.now()

  // eslint-disable-next-line no-restricted-syntax -- sandbox-only proof fixture, not a business write
  const { data: acct } = await db.from("accounts").insert({ company_name: `ZZ S4 Proof Co ${tag}`, status: "Active" }).select("id").single()
  // eslint-disable-next-line no-restricted-syntax -- sandbox-only proof fixture, not a business write
  const { data: people } = await db.from("contacts").insert([{ full_name: "ZZ S4 Owner" }, { full_name: "ZZ S4 Member" }]).select("id")
  const [p1, p2] = people.map((p: { id: string }) => p.id)
  // eslint-disable-next-line no-restricted-syntax -- sandbox-only proof fixture, not a business write
  await db.from("account_contacts").insert([{ account_id: acct.id, contact_id: p1, role: "owner" }, { account_id: acct.id, contact_id: p2, role: "member" }])
  const { data: ownerId } = await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: acct.id })
  await db.rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: "company_standard", p_root_name: `ZZ S4 Proof Co ${tag}` })
  const { data: corr } = await db.from("store_folders").select("id").eq("owner_id", ownerId).eq("kind", "correspondence").single()
  const { data: sub } = await db.rpc("store_ensure_folder_path", { p_owner: ownerId, p_parent: corr.id, p_path: ["2025", "Letters"], p_actor: staff.id })
  const { data: mid } = await db.from("store_folders").select("parent_id").eq("id", sub).single()

  const save = (folderId: string, name: string, text: string, extra: Record<string, unknown> = {}) =>
    saveBytesToStore({ ownerId, folderId, name, bytes: Buffer.from(text), callerKey: null, contentChanged: true, actor: staff.id,
      documentType: "irs_notice", published: true, ...extra })
  const a = await save(sub, "Letter A.txt", "letter A body")
  const b = await save(mid.parent_id, "Summary.txt", "summary body")
  const pass = await save(sub, "Passport Member.txt", "PASSPORT OF MEMBER", {
    documentType: "passport", subjects: [{ kind: "person", contactId: p2, role: "concerns" }],
  })

  // ── 1. real zip for the owner (member p2's passport must not be in it)
  const listing = await folderZipListing(mid.parent_id, { viewer: { contactId: p1 } })
  const files = unzipSync(await collect(streamZip(listing)))
  const names = Object.keys(files).sort()
  if (names.join("|") !== "Letters/Letter A.txt|Summary.txt" || strFromU8(files["Letters/Letter A.txt"]) !== "letter A body") {
    throw new Error(`CHECK 1 FAILED: zip holds ${names.join(", ")}`)
  }
  const memberZip = unzipSync(await collect(streamZip(await folderZipListing(mid.parent_id, { viewer: { contactId: p2 } }))))
  if (!Object.keys(memberZip).includes("Letters/Passport Member.txt")) throw new Error("CHECK 1 FAILED: the member's own passport missing from their zip")
  const staffZip = unzipSync(await collect(streamZip(await folderZipListing(mid.parent_id, { staff }))))
  if (Object.keys(staffZip).length !== 3) throw new Error("CHECK 1 FAILED: staff zip should hold all 3 files")
  console.log(`CHECK 1 passed — real streamed zips: owner gets ${names.length} files (no co-member passport), the member gets their own passport, staff get all 3`)

  // ── 2. real whole-folder upload with one bad path
  const report = await startFolderUpload(staff, { ownerId, parentFolderId: corr.id, files: [
    { relativePath: "Upload/Docs/one.txt" }, { relativePath: "Upload/Docs/two.txt" }, { relativePath: "Upload/../bad.txt" },
  ] })
  const ready = report.filter((r) => r.status === "ready")
  if (ready.length !== 2 || report.find((r) => r.relativePath === "Upload/../bad.txt")?.status !== "refused") {
    throw new Error(`CHECK 2 FAILED: report ${JSON.stringify(report.map((r) => [r.relativePath, r.status]))}`)
  }
  for (const r of ready) {
    if (r.status !== "ready") continue
    const { error } = await db.storage.from(STORE_STAGING_BUCKET).upload(r.intent.stagingPath, Buffer.from(`body of ${r.relativePath}`), { upsert: false })
    if (error) throw new Error(`CHECK 2 FAILED: staging upload ${error.message}`)
    const w = await registerNow({ intentId: r.intent.intentId, actor: staff.id })
    if (w.status !== "created") throw new Error(`CHECK 2 FAILED: register ${w.status}`)
  }
  const docsFolder = ready[0].status === "ready" ? ready[0].folderId : ""
  const { data: inDocs } = await db.from("store_files").select("name").eq("folder_id", docsFolder).eq("state", "live")
  if ((inDocs ?? []).length !== 2) throw new Error(`CHECK 2 FAILED: ${inDocs?.length} files in Upload/Docs`)
  console.log("CHECK 2 passed — real folder upload: Upload/Docs created once, 2 files uploaded + registered, the bad path refused on its own line")

  // ── 3. real time-travelled purge of one trashed file
  const { data: ver } = await db.from("store_file_versions").select("storage_path").eq("file_id", b.fileId).single()
  await trashFile(staff, b.fileId, "proof")
  const early = await purgeExpiredStore(new Date(Date.now() + 91 * 24 * 3600 * 1000), { ...purgeIO, listDue: async () => [b.fileId] })
  if (early.purged !== 0 || early.skipped !== 1) throw new Error(`CHECK 3 FAILED: a caller's future date purged a file ${JSON.stringify(early)}`)
  await db.from("store_files").update({ purge_after: new Date(Date.now() - 60_000).toISOString() }).eq("id", b.fileId)
  const tally = await purgeExpiredStore(new Date(), { ...purgeIO, listDue: async () => [b.fileId] })
  const { data: gone } = await db.storage.from(STORE_BUCKET).list(ownerId, { search: ver.storage_path.split("/")[1] })
  const { data: row } = await db.from("store_files").select("state").eq("id", b.fileId).single()
  if (tally.purged !== 1 || tally.objectsRemoved !== 1 || tally.errors !== 0 || (gone ?? []).length !== 0 || row.state !== "purged") {
    throw new Error(`CHECK 3 FAILED: ${JSON.stringify(tally)} objects left ${gone?.length} state ${row.state}`)
  }
  console.log("CHECK 3 passed — a caller's future date purges nothing; once the file's own purge date has passed, the real purge removes the bytes and keeps the tombstone")

  // cleanup: remove the remaining proof objects (rows stay dark under the ZZ records)
  const { data: left } = await db.from("store_file_versions").select("storage_path, store_files!inner(owner_id)").eq("store_files.owner_id", ownerId)
  const paths = (left ?? []).map((l: { storage_path: string }) => l.storage_path)
  if (paths.length) await db.storage.from(STORE_BUCKET).remove(paths)
  void a; void pass
  console.log("ALL S4 STORAGE CHECKS PASSED")
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1) })
