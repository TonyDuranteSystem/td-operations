/**
 * File Understanding — "Move to another client / person" (job 685467b5, Part 15 safe tool #2). The only place a file
 * changes OWNER on staff's word. The ordinary move stays inside one owner on purpose. Rules, all in code:
 *   · the file lands HIDDEN from the new owner's client and UNSHARED — `published` is cleared, its CRM record is set
 *     not-visible, the notified stamp and flow stage are cleared, every staff share is removed (a failure to remove
 *     a share undoes the whole move — it never continues with a stale tick);
 *   · its CRM record follows (account / contact / category) — never left pointing at the old owner;
 *   · one file at a time; EVERY move writes a store_ai_decisions row with what it was BEFORE (owner, folder, published,
 *     the CRM record's fields), so `undoMove` puts it back exactly — and only once, only while the file is still where
 *     the move left it;
 *   · nothing is deleted; the store's own history logs the re-home.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

const REC = "id, portal_visible, account_id, contact_id, category, category_name, client_notified_at, flow_stage"

export async function moveFileToOwner(p: { fileId: string; toFolderId: string; actor: string; analysisId?: string | null; reason?: string }): Promise<{ decisionId: string; toOwnerId: string }> {
  if (!p.actor) throw new Error("Only a named staff member can move a file to another client.")
  const { data: f } = await db().from("store_files").select("id, owner_id, folder_id, state, name, document_type, published, filing_status").eq("id", p.fileId).maybeSingle()
  if (!f || f.state !== "live") throw new Error("The file is not available.")
  if (f.filing_status === "filed") throw new Error("A filed return stays where it is.")
  const { data: to } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", p.toFolderId).maybeSingle()
  if (!to || to.trashed_at) throw new Error("That folder is not available.")
  if (to.owner_id === f.owner_id) throw new Error("That folder belongs to the same client — use the ordinary move.")
  if (to.kind === "root" || to.kind === "contacts") throw new Error("Choose a real folder inside the other client's storage.")

  const { storePointer } = await import("../document-pointer")
  const pointer = storePointer(p.fileId)
  const { data: recs } = await db().from("documents").select(REC).eq("drive_file_id", pointer)
  const before = { owner_id: f.owner_id, folder_id: f.folder_id, published: f.published === true, records: recs ?? [] }
  const { data: dest } = await db().from("store_owners").select("account_id, contact_id").eq("id", to.owner_id).maybeSingle()
  const { categoryForFolder } = await import("../structure")
  const cat = await categoryForFolder(p.toFolderId)

  const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: p.fileId, p_to_folder: p.toFolderId, p_actor: p.actor, p_reason: p.reason?.trim() || "Moved to another client (File Understanding)" })
  if (rhErr) throw new Error(`The file could not be moved (${String(rhErr.message).replace(/^store: /, "")}).`)
  const putBack = async () => {
    await db().rpc("store_rehome_file", { p_file_id: p.fileId, p_to_folder: f.folder_id, p_actor: p.actor, p_reason: "Move failed — put back" })
    await db().from("store_files").update({ published: before.published }).eq("id", p.fileId)
    for (const r of before.records) { const { id, ...fields } = r; await db().from("documents").update(fields).eq("id", id) }
  }
  try {
    const { error: pErr } = await db().from("store_files").update({ published: false }).eq("id", p.fileId)
    if (pErr) throw new Error(pErr.message)
    if ((recs ?? []).length > 0) {
      const { error } = await db().from("documents").update({
        portal_visible: false, client_notified_at: null, flow_stage: null, account_id: dest?.account_id ?? null, contact_id: dest?.contact_id ?? null,
        category: cat.num, category_name: cat.name, updated_at: new Date().toISOString(),
      }).eq("drive_file_id", pointer)
      if (error) throw new Error(error.message)
    }
    const { clearShares } = await import("../staff-share")
    await clearShares([p.fileId], p.actor, "moved to another client")            // a failure here undoes the move (below)
  } catch (e) {
    await putBack().catch((b) => console.error("[understand] move roll-back incomplete:", b))
    throw new Error(`The move was undone because the file could not be hidden and unshared safely (${e instanceof Error ? e.message : "error"}).`)
  }
  const { data: d, error: dErr } = await db().from("store_ai_decisions").insert({
    analysis_id: p.analysisId ?? null, file_id: p.fileId, action: "moved", before_state: before, after_state: { owner_id: to.owner_id, folder_id: p.toFolderId, hidden: true }, actor: p.actor,
  }).select("id").single()
  if (dErr || !d) {
    await putBack().catch((b) => console.error("[understand] move roll-back incomplete:", b))
    throw new Error("The move could not be recorded, so it was undone.")
  }
  return { decisionId: d.id as string, toOwnerId: to.owner_id }
}

/** The file a move decision concerns (for the route's access checks). */
export async function moveDecisionFile(decisionId: string): Promise<string | null> {
  const { data } = await db().from("store_ai_decisions").select("file_id, action").eq("id", decisionId).maybeSingle()
  return data && data.action === "moved" ? data.file_id : null
}

/** Put a moved file back exactly as it was (owner, folder, published flag, the CRM record) — once, and only while it is still where the move left it. */
export async function undoMove(decisionId: string, actor: string): Promise<void> {
  if (!actor) throw new Error("Only a named staff member can undo a move.")
  const { data: d } = await db().from("store_ai_decisions").select("id, file_id, analysis_id, action, before_state, after_state").eq("id", decisionId).maybeSingle()
  if (!d || d.action !== "moved") throw new Error("That is not a move that can be undone.")
  const { data: later } = await db().from("store_ai_decisions").select("id, before_state").eq("file_id", d.file_id).eq("action", "changed").gte("created_at", (await db().from("store_ai_decisions").select("created_at").eq("id", decisionId).single()).data.created_at)
  if (((later ?? []) as { before_state: { undone?: string } | null }[]).some((x) => x.before_state?.undone === decisionId)) throw new Error("This move was already undone.")
  const { data: f } = await db().from("store_files").select("owner_id, state").eq("id", d.file_id).maybeSingle()
  const after = d.after_state as { owner_id: string }
  if (!f || f.state !== "live") throw new Error("The file is not available.")
  if (f.owner_id !== after.owner_id) throw new Error("The file has been moved again since — it cannot be undone from here.")
  const before = d.before_state as { folder_id: string; published?: boolean; records: Array<Record<string, unknown> & { id: string }> }
  const { error } = await db().rpc("store_rehome_file", { p_file_id: d.file_id, p_to_folder: before.folder_id, p_actor: actor, p_reason: "Move undone (File Understanding)" })
  if (error) throw new Error(`The move could not be undone (${String(error.message).replace(/^store: /, "")}).`)
  await db().from("store_files").update({ published: before.published === true }).eq("id", d.file_id)
  for (const r of before.records) {
    const { id, ...fields } = r
    await db().from("documents").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id)
  }
  await db().from("store_ai_decisions").insert({ analysis_id: d.analysis_id, file_id: d.file_id, action: "changed", before_state: { undone: decisionId }, after_state: null, actor })
}
