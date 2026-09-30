/**
 * File Understanding — "Move to another client / person" (job 685467b5, Part 15 safe tool #2). The only place a file
 * changes OWNER on staff's word. The ordinary move stays inside one owner on purpose. Rules, all in code:
 *   · the file lands HIDDEN from the new owner's client and UNSHARED — a wrong move can never show a document
 *     (the open portal leak, job 197e13ad, is why): portal_visible=false, notified stamp and flow stage cleared;
 *   · its CRM record follows (account / contact / category) — never left pointing at the old owner;
 *   · one file at a time; every move is written to store_ai_decisions with what it was BEFORE, so `undoMove` puts it
 *     back exactly (folder, owner, CRM record fields) — the undo is a first-class function, not a promise;
 *   · nothing is deleted; the store's own history logs the re-home.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

const REC = "id, portal_visible, account_id, contact_id, category, category_name, client_notified_at, flow_stage"

export async function moveFileToOwner(p: { fileId: string; toFolderId: string; actor: string; analysisId?: string | null; reason?: string }): Promise<{ decisionId: string | null; toOwnerId: string }> {
  if (!p.actor) throw new Error("Only a named staff member can move a file to another client.")
  const { data: f } = await db().from("store_files").select("id, owner_id, folder_id, state, name, document_type").eq("id", p.fileId).maybeSingle()
  if (!f || f.state !== "live") throw new Error("The file is not available.")
  const { data: to } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", p.toFolderId).maybeSingle()
  if (!to || to.trashed_at) throw new Error("That folder is not available.")
  if (to.owner_id === f.owner_id) throw new Error("That folder belongs to the same client — use the ordinary move.")
  if (to.kind === "root" || to.kind === "contacts") throw new Error("Choose a real folder inside the other client's storage.")
  const { data: filed } = await db().from("store_files").select("filing_status").eq("id", p.fileId).maybeSingle()
  if (filed?.filing_status === "filed") throw new Error("A filed return stays where it is.")

  const { storePointer } = await import("../document-pointer")
  const pointer = storePointer(p.fileId)
  const { data: recs } = await db().from("documents").select(REC).eq("drive_file_id", pointer)
  const before = { owner_id: f.owner_id, folder_id: f.folder_id, records: recs ?? [] }
  // who owns the destination
  const { data: dest } = await db().from("store_owners").select("account_id, contact_id").eq("id", to.owner_id).maybeSingle()
  const { categoryForFolder } = await import("../structure")
  const cat = await categoryForFolder(p.toFolderId)

  const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: p.fileId, p_to_folder: p.toFolderId, p_actor: p.actor, p_reason: p.reason?.trim() || "Moved to another client (File Understanding)" })
  if (rhErr) throw new Error(`The file could not be moved (${String(rhErr.message).replace(/^store: /, "")}).`)
  try {
    if ((recs ?? []).length > 0) {
      const { error } = await db().from("documents").update({
        portal_visible: false, client_notified_at: null, flow_stage: null, account_id: dest?.account_id ?? null, contact_id: dest?.contact_id ?? null,
        category: cat.num, category_name: cat.name, updated_at: new Date().toISOString(),
      }).eq("drive_file_id", pointer)
      if (error) throw new Error(error.message)
    }
    const { clearShares } = await import("../staff-share")
    await clearShares([p.fileId], p.actor, "moved to another client").catch((e: unknown) => console.error("[understand] shares not cleared:", e))
  } catch (e) {
    await db().rpc("store_rehome_file", { p_file_id: p.fileId, p_to_folder: f.folder_id, p_actor: p.actor, p_reason: "Move failed — put back" })
    throw new Error(`The CRM record could not follow, so the file was put back (${e instanceof Error ? e.message : "error"}).`)
  }
  let decisionId: string | null = null
  if (p.analysisId) {
    const { data: d } = await db().from("store_ai_decisions").insert({ analysis_id: p.analysisId, file_id: p.fileId, action: "moved", before_state: before, after_state: { owner_id: to.owner_id, folder_id: p.toFolderId, hidden: true }, actor: p.actor }).select("id").single()
    decisionId = d?.id ?? null
  }
  return { decisionId, toOwnerId: to.owner_id }
}

/** Put a moved file back exactly as it was (owner, folder, the CRM record's visibility and links). */
export async function undoMove(decisionId: string, actor: string): Promise<void> {
  if (!actor) throw new Error("Only a named staff member can undo a move.")
  const { data: d } = await db().from("store_ai_decisions").select("id, file_id, action, before_state").eq("id", decisionId).maybeSingle()
  if (!d || d.action !== "moved") throw new Error("That is not a move that can be undone.")
  const before = d.before_state as { folder_id: string; records: Array<Record<string, unknown> & { id: string }> }
  const { error } = await db().rpc("store_rehome_file", { p_file_id: d.file_id, p_to_folder: before.folder_id, p_actor: actor, p_reason: "Move undone (File Understanding)" })
  if (error) throw new Error(`The move could not be undone (${String(error.message).replace(/^store: /, "")}).`)
  for (const r of before.records) {
    const { id, ...fields } = r
    await db().from("documents").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id)
  }
  await db().from("store_ai_decisions").insert({ analysis_id: (await db().from("store_ai_decisions").select("analysis_id").eq("id", decisionId).maybeSingle()).data?.analysis_id, file_id: d.file_id, action: "changed", before_state: { undone: decisionId }, after_state: null, actor })
}
