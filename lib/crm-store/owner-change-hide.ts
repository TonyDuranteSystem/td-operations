/**
 * A file that changes OWNER (person → company, person → another person) must not carry its old audience with it:
 * "visible to the client" was a decision about the OLD owner's people, and a company's file is seen by every member.
 * So the file is HIDDEN from the client when it moves between owners, its workspace stage is cleared (the portal can
 * show a workspace document by stage alone), and the client "notified" stamp is cleared. Staff look at it and show it
 * again on purpose. Same pattern as File Understanding's move (understand/move-owner.ts).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export const OWNER_CHANGE_HIDDEN_NOTE = "The file is now hidden from the client because it changed owner — check it, then show it again if it should be shared."

export interface OwnerChangeRow { id: string; portal_visible: boolean | null; flow_stage: string | null; client_notified_at: string | null }

/** Pure: was the file in front of any client, and what the CRM rows become. */
export function ownerChangeHidePlan(published: boolean, rows: OwnerChangeRow[]): { wasVisible: boolean; patch: { portal_visible: false; flow_stage: null; client_notified_at: null }; note: string | null } {
  const wasVisible = published === true || rows.some((r) => r.portal_visible === true || !!r.flow_stage)
  return { wasVisible, patch: { portal_visible: false, flow_stage: null, client_notified_at: null }, note: wasVisible ? OWNER_CHANGE_HIDDEN_NOTE : null }
}

/**
 * Hide the file from the client BEFORE it is re-homed. Returns what to tell staff and a `restore()` that puts the
 * old state back if the move then fails. Throws (nothing changed) if it cannot be hidden safely.
 */
export async function hideForOwnerChange(fileId: string, actorId: string | null): Promise<{ note: string | null; restore: () => Promise<void> }> {
  const { storePointer } = await import("./document-pointer")
  const pointer = storePointer(fileId)
  const { data: f, error: fErr } = await db().from("store_files").select("published").eq("id", fileId).maybeSingle()
  if (fErr || !f) throw new Error(`Could not read the file — please try again (${fErr?.message ?? "not found"}).`)
  const { data: rows, error: rErr } = await db().from("documents").select("id, portal_visible, flow_stage, client_notified_at").eq("drive_file_id", pointer)
  if (rErr) throw new Error(`Could not read the CRM listing — please try again (${rErr.message}).`)
  const before = (rows ?? []) as OwnerChangeRow[]
  const plan = ownerChangeHidePlan(f.published === true, before)
  const wasPublished = f.published === true
  const restore = async () => {
    if (wasPublished) await db().rpc("store_set_published", { p_file_id: fileId, p_published: true, p_actor: actorId })
    for (const r of before) { const { id, ...fields } = r; await db().from("documents").update(fields).eq("id", id) }
  }
  if (!plan.wasVisible) return { note: null, restore: async () => {} }
  if (wasPublished) {
    const { error } = await db().rpc("store_set_published", { p_file_id: fileId, p_published: false, p_actor: actorId })
    if (error) throw new Error(`The file could not be hidden from the client first, so it was not moved (${String(error.message).replace(/^store: /, "")}).`)
  }
  if (before.length > 0) {
    const { error } = await db().from("documents").update({ ...plan.patch, updated_at: new Date().toISOString() }).eq("drive_file_id", pointer)
    if (error) {
      await restore()
      throw new Error(`The file could not be hidden from the client first, so it was not moved (${error.message}).`)
    }
  }
  return { note: plan.note, restore }
}
