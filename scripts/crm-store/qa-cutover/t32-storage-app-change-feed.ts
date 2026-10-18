/* eslint-disable no-console */
/**
 * Storage Mac app, phase P0 gate (dev job 1992a087): the change feed. SANDBOX only.
 * Proves, against the real sandbox database and the real library functions, that Finder can learn every change:
 * new folder / file / version, rename, move, trash, restore, hard delete, a storage going live / hidden, a CRM name change,
 * a row that commits LATE (it must not be lost behind a cursor), and an old cursor after the log was pruned (full refresh).
 * Run: npx tsx scripts/crm-store/qa-cutover/t32-storage-app-change-feed.ts
 */
import { config } from "dotenv"
import { Client } from "pg"
import { randomUUID } from "crypto"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const UX_ACCOUNT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const STAFF = { id: "00000000-0000-4000-8000-000000000032", email: "qa-feed@example.test", app_metadata: { role: "team" }, user_metadata: {}, aud: "authenticated", created_at: "" } as never

async function main() {
  const url = process.env.SUPABASE_DB_URL || ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("REFUSED: not the sandbox database")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; rpc: (f: string, a?: any) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { changesSince, changesHead, parseCursor } = await import("../../../lib/storage-app/changes")
  const { createFolder, renameFolder, moveFolder } = await import("../../../lib/crm-store/structure")
  const { saveBytesToStore } = await import("../../../lib/crm-store/writer")
  const { renameStoreFile, moveStoreFile } = await import("../../../lib/crm-store/file-actions")
  const { trashFile, restoreBatch } = await import("../../../lib/crm-store/folders")

  const { data: owner } = await sb.from("store_owners").select("id, study_only").eq("account_id", UX_ACCOUNT).eq("kind", "company").maybeSingle()
  if (!owner) throw new Error("Uxio Test LLC has no company storage in the sandbox")
  const { data: root } = await sb.from("store_folders").select("id").eq("owner_id", owner.id).is("parent_id", null).maybeSingle()
  const tag = `QA Test ap-feed ${Date.now()}`
  // a real sandbox staff login to act as (the trash functions write the actor id): the first admin of the sandbox (paged)
  let qa: { id: string } | null = null
  for (let page = 1; page <= 10 && !qa; page++) {
    const { data: users } = await (supabaseAdmin as any).auth.admin.listUsers({ page, perPage: 200 }) // eslint-disable-line @typescript-eslint/no-explicit-any
    qa = (users?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin") ?? null
    if (!(users?.users ?? []).length) break
  }
  if (!qa) throw new Error("no admin login found in the sandbox")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never

  // everything from here on is read through the SAME function the app route uses, for a team-role login
  let cursor = await changesHead()
  const drain = async () => {
    const out: Awaited<ReturnType<typeof changesSince>>["changes"] = []
    for (let i = 0; i < 20; i++) {
      const page = await changesSince(STAFF, cursor ? parseCursor(cursor) : null, 500)
      if (page.resync) throw new Error("unexpected resync")
      out.push(...page.changes)
      if (page.cursor) cursor = page.cursor
      if (!page.hasMore) break
    }
    return out
  }
  const mine = (cs: Awaited<ReturnType<typeof drain>>, id: string) => cs.filter((c) => c.id === id)
  const trashFolderRpc = async (id: string) => { const { error } = await sb.rpc("store_trash_folder", { p_folder_id: id, p_actor: qa!.id, p_reason: "qa feed" }); if (error) throw new Error(error.message) }

  // A — folder created
  const f1 = await createFolder(root!.id, `${tag} A`, null)
  const f2 = await createFolder(root!.id, `${tag} B`, null)
  let cs = await drain()
  check("A folder created → one upsert with its parent and name", mine(cs, f1.id).length === 1 && mine(cs, f1.id)[0].op === "upsert" && mine(cs, f1.id)[0].parentId === root!.id && mine(cs, f1.id)[0].name === `${tag} A`, JSON.stringify(mine(cs, f1.id)))

  // B — file saved, then a NEW VERSION of it
  const saved = await saveBytesToStore({ ownerId: owner.id, folderId: f1.id, name: "QA feed.txt", mimeType: "text/plain", callerKey: `qa-feed:${tag}`, contentChanged: true, bytes: Buffer.from("one " + tag), documentType: null })
  const fileId = (saved as { fileId: string }).fileId
  cs = await drain()
  check("B file saved → upsert(s) in its folder (the insert and the version link are two rows; Finder keeps the last by id)", mine(cs, fileId).length >= 1 && mine(cs, fileId).every((c) => c.op === "upsert" && c.parentId === f1.id), JSON.stringify(mine(cs, fileId)))
  await saveBytesToStore({ ownerId: owner.id, folderId: f1.id, name: "QA feed.txt", mimeType: "text/plain", callerKey: `qa-feed:${tag}`, contentChanged: true, bytes: Buffer.from("two " + tag), documentType: null })
  cs = await drain()
  check("B2 new version → an upsert (Finder re-reads the file)", mine(cs, fileId).length === 1 && mine(cs, fileId)[0].op === "upsert", JSON.stringify(mine(cs, fileId)))

  // C — renames
  await renameFolder(f1.id, `${tag} A2`, null)
  await renameStoreFile(fileId, "QA feed renamed.txt", null)
  cs = await drain()
  check("C folder rename → upsert with the new name", mine(cs, f1.id).some((c) => c.name === `${tag} A2`), JSON.stringify(mine(cs, f1.id)))
  check("C2 file rename → upsert with the new name", mine(cs, fileId).some((c) => c.name === "QA feed renamed.txt"), JSON.stringify(mine(cs, fileId)))

  // D — moves carry the OLD parent (a move, not delete + add)
  await moveStoreFile(fileId, f2.id, null)
  cs = await drain()
  const mv = mine(cs, fileId).find((c) => c.parentId === f2.id)
  check("D file move → upsert with new parent AND old parent", !!mv && mv.oldParentId === f1.id, JSON.stringify(mine(cs, fileId)))
  await moveFolder(f2.id, f1.id, null)
  cs = await drain()
  const mf = mine(cs, f2.id).find((c) => c.parentId === f1.id)
  check("D2 folder move → upsert with new parent AND old parent", !!mf && mf.oldParentId === root!.id, JSON.stringify(mine(cs, f2.id)))

  // E — trash → tombstone; restore → upsert again
  const batch = await trashFile(ACTOR, fileId, "qa feed")
  cs = await drain()
  check("E trash → a delete tombstone", mine(cs, fileId).length === 1 && mine(cs, fileId)[0].op === "delete", JSON.stringify(mine(cs, fileId)))
  await restoreBatch(ACTOR, batch, null)
  cs = await drain()
  check("E2 restore → an upsert again", mine(cs, fileId).some((c) => c.op === "upsert"), JSON.stringify(mine(cs, fileId)))

  // E3 — trashing a FOLDER tombstones the folder AND everything inside it
  const fz = await createFolder(root!.id, `${tag} Z`, null)
  const inZ = await saveBytesToStore({ ownerId: owner.id, folderId: fz.id, name: "QA feed in Z.txt", mimeType: "text/plain", callerKey: `qa-feed-z:${tag}`, contentChanged: true, bytes: Buffer.from("z" + tag), documentType: null })
  const inZid = (inZ as { fileId: string }).fileId
  await drain()
  await trashFolderRpc(fz.id)
  cs = await drain()
  check("E3 trashing a folder → a delete for the folder AND for the file inside it", mine(cs, fz.id).some((c) => c.op === "delete") && mine(cs, inZid).some((c) => c.op === "delete"), JSON.stringify([mine(cs, fz.id), mine(cs, inZid)].map((a) => a.map((c) => c.op))))

  // F — a hard delete of a live file (a purge path / clean-up) still leaves a tombstone
  const extra = await saveBytesToStore({ ownerId: owner.id, folderId: f1.id, name: "QA feed hard delete.txt", mimeType: "text/plain", callerKey: `qa-feed-del:${tag}`, contentChanged: true, bytes: Buffer.from("x" + tag), documentType: null })
  await drain()
  const delId = (extra as { fileId: string }).fileId
  await sb.from("store_files").update({ current_version_id: null }).eq("id", delId).then(() => null, () => null)
  const { error: delErr } = await sb.from("store_files").delete().eq("id", delId)
  cs = await drain()
  check("F hard delete → a tombstone (or the database refuses the delete, which is also safe)", !!delErr || mine(cs, delId).some((c) => c.op === "delete"), delErr ? `refused: ${delErr.message}` : JSON.stringify(mine(cs, delId)))

  // G — a storage going hidden / live again
  await sb.from("store_owners").update({ study_only: true }).eq("id", owner.id)
  cs = await drain()
  check("G storage hidden → an owner delete (no name)", mine(cs, owner.id).some((c) => c.kind === "owner" && c.op === "delete" && c.name === null), JSON.stringify(mine(cs, owner.id)))
  await sb.from("store_owners").update({ study_only: false }).eq("id", owner.id)
  cs = await drain()
  check("G2 storage live again → an owner upsert", mine(cs, owner.id).some((c) => c.kind === "owner" && c.op === "upsert"), JSON.stringify(mine(cs, owner.id)))

  // H — a CRM name change moves the owner (group / label) — and is put back
  const { data: acc } = await sb.from("accounts").select("company_name").eq("id", UX_ACCOUNT).maybeSingle()
  // eslint-disable-next-line no-restricted-syntax -- QA of the database trigger itself: it must fire on a plain row update, whoever makes it
  await sb.from("accounts").update({ company_name: `${acc.company_name} ` }).eq("id", UX_ACCOUNT)
  // eslint-disable-next-line no-restricted-syntax -- put the test company's name back
  await sb.from("accounts").update({ company_name: acc.company_name }).eq("id", UX_ACCOUNT)
  cs = await drain()
  check("H CRM company-name change → an owner upsert", mine(cs, owner.id).some((c) => c.kind === "owner" && c.op === "upsert"), JSON.stringify(mine(cs, owner.id)))

  // I — a row that commits LATE must not be lost behind a cursor
  const base = cursor
  const held = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await held.connect()
  await held.query("BEGIN")
  const lateId = randomUUID()
  await held.query("INSERT INTO store_folders (id, owner_id, parent_id, kind, name, created_by) VALUES ($1,$2,$3,'custom',$4,NULL)", [lateId, owner.id, f1.id, `${tag} late`])
  // (a different storage: folder writes lock their own storage, so the quick change must not wait for the held one)
  const { data: biz } = await sb.from("store_owners").select("id").eq("kind", "business").maybeSingle()
  const { data: bizRoot } = await sb.from("store_folders").select("id").eq("owner_id", biz.id).is("parent_id", null).maybeSingle()
  const quick = await createFolder(bizRoot.id, `${tag} quick`, null)     // committed AFTER the held one started
  const during = await changesSince(STAFF, base ? parseCursor(base) : null, 500)
  check("I while an older transaction is open, newer rows are held back too (no gap can open)", !during.changes.some((c) => c.id === lateId || c.id === quick.id), JSON.stringify(during.changes.map((c) => c.name)))
  await held.query("COMMIT")
  await held.end()
  const after = await changesSince(STAFF, base ? parseCursor(base) : null, 500)
  check("I2 once it commits, BOTH the late row and the quick one arrive from the old cursor", after.changes.some((c) => c.id === lateId) && after.changes.some((c) => c.id === quick.id), JSON.stringify(after.changes.map((c) => c.name)))
  const order = after.changes.map((c) => c.id)
  check("I3 late row is delivered before the quick one (transaction order)", order.indexOf(lateId) >= 0 && order.indexOf(lateId) < order.indexOf(quick.id), order.join(","))
  if (after.cursor) cursor = after.cursor

  // J — the app starts from head, repeats nothing, and a repeat of the same cursor adds nothing
  const again = await drain()
  check("J nothing new → nothing returned (the cursor is stable)", again.length === 0, JSON.stringify(again))

  // K — prune everything → a cursor at or before the pruned part must be told to refresh in full (a cursor ON the pruned tip cannot
  //     prove it saw the rest of that transaction); a cursor taken AFTER the prune must not
  const upToDate = cursor
  const { data: pruned } = await sb.rpc("store_change_log_prune", { p_keep: "0 seconds" })
  const stale = await changesSince(STAFF, base ? parseCursor(base) : null, 500)
  check("K an old cursor after pruning → resync", base === null || stale.resync === true, `pruned=${pruned} resync=${stale.resync}`)
  const onTip = await changesSince(STAFF, upToDate ? parseCursor(upToDate) : null, 500)
  check("K2 a cursor sitting exactly on the pruned tip is also told to resync (it cannot prove it saw everything)", upToDate === null || onTip.resync === true, `resync=${onTip.resync}`)
  const fresh = await changesSince(STAFF, null, 5)
  check("K3 a brand-new device (no cursor) is not told to resync", fresh.resync === false, "")
  const afterPrune = await createFolder(root!.id, `${tag} after prune`, null)
  const c1 = await changesSince(STAFF, null, 500)
  check("K4 a change made after the prune arrives for a new device", c1.changes.some((c) => c.id === afterPrune.id), JSON.stringify(c1.changes.map((c) => c.name)))
  await createFolder(root!.id, `${tag} after prune 2`, null)
  const c2 = await changesSince(STAFF, c1.cursor ? parseCursor(c1.cursor) : null, 500)
  check("K5 and from its own cursor the next change arrives with NO resync", c2.resync === false && c2.changes.length >= 1, `resync=${c2.resync} n=${c2.changes.length}`)

  // clean up what this run made (trash the test folders; sandbox only)
  await sb.rpc("store_trash_folder", { p_folder_id: f1.id, p_actor: qa.id, p_reason: "qa feed clean-up" }).then(() => null, () => null)
  await sb.rpc("store_trash_folder", { p_folder_id: quick.id, p_actor: qa.id, p_reason: "qa feed clean-up" }).then(() => null, () => null)
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
