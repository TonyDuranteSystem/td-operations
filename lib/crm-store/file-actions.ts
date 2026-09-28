/**
 * Staff file actions on the NEW CRM store (job 685467b5) — the same actions the Drive folder view offers
 * today (rename, move to another folder, delete), done on the store and kept in step with the CRM documents
 * list the portal reads:
 *   - rename  → the file's name + its CRM row's file_name (today: Drive rename + row rename)
 *   - move    → another folder of the SAME owner; the row's category follows the folder (today: Drive move +
 *               category follows unless kept); a personal document never leaves a person's storage and a
 *               company document never goes into "2. Contacts"
 *   - delete  → the store TRASH (recoverable, legal holds apply) + the CRM row removed so the portal stops
 *               listing it (today: Drive trash + row deleted). A staff member is required.
 * Every action is logged in the store's own history.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

async function liveFile(fileId: string) {
  const { data: f, error } = await db().from("store_files")
    .select("id, name, owner_id, folder_id, document_type, state, store_owners!inner(kind)").eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file — please try again (${error.message}).`)
  if (!f) throw new Error("File not found.")
  if (f.state !== "live") throw new Error("This file is in the trash.")
  return f as { id: string; name: string; owner_id: string; folder_id: string; document_type: string | null; state: string; store_owners: { kind: string } }
}

export { cleanNewFileName } from "./names"
import { cleanNewFileName } from "./names"

async function logEvent(event: string, f: { id: string; owner_id: string; folder_id: string; name: string }, actor: string | null, details: Record<string, unknown>) {
  const { error } = await db().from("store_events").insert({
    event, actor, owner_id: f.owner_id, file_id: f.id, folder_id: f.folder_id, name_snapshot: f.name, details,
  })
  if (error) console.error(`[crm-store] ${event} not logged for ${f.id}: ${error.message}`)
}

export async function renameStoreFile(fileId: string, newName: string, actorId: string | null): Promise<{ name: string }> {
  const f = await liveFile(fileId)
  const name = cleanNewFileName(newName, f.name)
  if (name === f.name) return { name }
  const { error } = await db().from("store_files").update({ name }).eq("id", fileId).eq("state", "live")
  if (error) {
    if (/store_files_folder_name_uq|duplicate key/i.test(error.message)) throw new Error("A file with this name is already in this folder.")
    throw new Error(`The file could not be renamed (${error.message}).`)
  }
  const { storePointer } = await import("./document-pointer")
  const { error: rErr } = await db().from("documents").update({ file_name: name, updated_at: new Date().toISOString() }).eq("drive_file_id", storePointer(fileId))
  if (rErr) {
    // never leave the store and the CRM list with two names: put the store's name back
    await db().from("store_files").update({ name: f.name }).eq("id", fileId)
    throw new Error(`The CRM list could not be updated, so the file was not renamed (${rErr.message}) — please try again.`)
  }
  await logEvent("renamed", { ...f, name }, actorId, { from: f.name, to: name })
  return { name }
}

export async function moveStoreFile(fileId: string, toFolderId: string, actorId: string | null): Promise<{ folderName: string }> {
  const f = await liveFile(fileId)
  const { data: to, error: tErr } = await db().from("store_folders").select("id, owner_id, name, kind, trashed_at").eq("id", toFolderId).maybeSingle()
  if (tErr) throw new Error(`Could not read the folder — please try again (${tErr.message}).`)
  if (!to || to.trashed_at) throw new Error("That folder is not available.")
  if (to.owner_id !== f.owner_id) throw new Error("A file can only be moved within the same company's or person's storage.")
  if (to.id === f.folder_id) return { folderName: to.name }
  const wasInsideShare = f.store_owners.kind === "private" && await (await import("./staff-share")).isInStaffShare(f.folder_id)
  if (to.kind === "root") throw new Error("Files go inside a folder, not at the top.")
  if (to.kind === "contacts") throw new Error("\"2. Contacts\" shows the people's own documents — a company document cannot go there.")
  const { error } = await db().from("store_files").update({ folder_id: toFolderId }).eq("id", fileId).eq("state", "live")
  if (error) {
    if (/store_files_folder_name_uq|duplicate key/i.test(error.message)) throw new Error(`"${to.name}" already has a file with this name.`)
    throw new Error(`The file could not be moved (${error.message}).`)
  }
  // the CRM row's category follows the folder, as today's Drive move does
  const { categoryForFolder } = await import("./structure")
  const cat = await categoryForFolder(toFolderId)
  if (f.store_owners.kind !== "person") {
    const { storePointer } = await import("./document-pointer")
    const { error: rErr } = await db().from("documents").update({ category: cat.num, category_name: cat.name, updated_at: new Date().toISOString() })
      .eq("drive_file_id", storePointer(fileId))
    if (rErr) {
      await db().from("store_files").update({ folder_id: f.folder_id }).eq("id", fileId)
      throw new Error(`The CRM list could not be updated, so the file was not moved (${rErr.message}) — please try again.`)
    }
  }
  await logEvent("moved", { ...f, folder_id: toFolderId }, actorId, { from_folder: f.folder_id, to_folder: toFolderId })
  // "Shared with staff": the ticks stay only if the file stayed inside it
  if (f.store_owners.kind === "private") {
    const { afterMove } = await import("./staff-share")
    await afterMove([fileId], wasInsideShare, actorId)
  }
  return { folderName: to.name }
}

export async function deleteStoreFile(fileId: string, actorId: string | null): Promise<{ crmRowsRemoved: number }> {
  if (!actorId) throw new Error("Only a signed-in staff member can delete a file.")
  await liveFile(fileId)
  // the CRM listing goes FIRST (kept in memory): if the store trash then refuses (a legal hold …), the
  // listing is put back — the portal never lists a file that is in the trash, and nothing is half-deleted
  const { storePointer } = await import("./document-pointer")
  const { data: removed, error: dErr } = await db().from("documents").delete().eq("drive_file_id", storePointer(fileId)).select("*")
  if (dErr) throw new Error(`The CRM list could not be updated, so the file was not deleted (${dErr.message}) — please try again.`)
  const { error } = await db().rpc("store_trash_file", { p_file_id: fileId, p_actor: actorId, p_reason: "Deleted by staff from the CRM" })
  if (error) {
    if ((removed ?? []).length > 0) {
      const { error: back } = await db().from("documents").insert(removed)
      if (back) console.error(`[crm-store] delete: CRM rows could not be put back for ${fileId}: ${back.message}`)
    }
    throw new Error(error.message.replace(/^store: /, ""))
  }
  // remember the removed listing so a restore from the trash brings it back (hidden)
  const { rememberRemovedRows } = await import("./trash")
  await rememberRemovedRows(removed ?? [], actorId)
  // a trashed file is never shared with staff again (not even after a restore)
  const { clearShares } = await import("./staff-share")
  await clearShares([fileId], actorId, "trashed").catch((e: unknown) => console.error("[crm-store] shares not cleared on delete:", e))
  return { crmRowsRemoved: (removed ?? []).length }
}
