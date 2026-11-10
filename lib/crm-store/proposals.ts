/**
 * Claude's PROPOSED changes (dev job bd21e833, master plan Part 54, step 2). A proposal is an ordinary hidden "not applied" version
 * (`store_file_versions.unmerged`) of a file the client can see; what makes it a proposal is the note kept with it in the history
 * (`store_events` "version_added", source "claude"). Accepting it is the existing "apply this edit" (a new current version made from it,
 * with the visible / hidden choice). Discarding it writes a "proposal_discarded" history row — nothing is ever deleted, and the history
 * is append-only, so no new column is needed.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
const db = () => supabaseAdmin as any

export interface VersionNote { note: string | null; source: string | null; discarded: boolean }

/** For each version of a file: the note and source from its history row, and whether it was discarded. Never throws (a missing note is just no note). */
export async function versionNotes(fileId: string): Promise<Map<string, VersionNote>> {
  const out = new Map<string, VersionNote>()
  try {
    const { data, error } = await db().from("store_events").select("event, details").eq("file_id", fileId).in("event", ["version_added", "proposal_discarded"]).order("id", { ascending: true }).limit(2000)
    if (error) return out
    for (const r of (data ?? []) as Array<{ event: string; details: { version_id?: string; note?: string; source?: string } | null }>) {
      const id = r.details?.version_id
      if (!id) continue
      const cur = out.get(id) ?? { note: null, source: null, discarded: false }
      if (r.event === "version_added") { cur.note = r.details?.note ?? null; cur.source = r.details?.source ?? null } else cur.discarded = true
      out.set(id, cur)
    }
  } catch { /* no notes */ }
  return out
}

/** The not-applied versions of each file that were discarded (version numbers), so the "unmerged" counter can leave them out. */
export async function discardedVersionNos(fileIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  if (fileIds.length === 0) return out
  try {
    for (let i = 0; i < fileIds.length; i += 100) {
      const { data, error } = await db().from("store_events").select("file_id, details").in("file_id", fileIds.slice(i, i + 100)).eq("event", "proposal_discarded").limit(5000)
      if (error) continue
      for (const r of (data ?? []) as Array<{ file_id: string; details: { version_no?: number } | null }>) {
        const n = Number(r.details?.version_no)
        if (Number.isInteger(n)) out.set(r.file_id, [...(out.get(r.file_id) ?? []), n])
      }
    }
  } catch { /* the counter then simply includes them */ }
  return out
}

/** Pure: how many not-applied versions still wait, after the discarded ones (newer than the current copy) are left out. */
export function pendingAfterDiscards(pending: number, currentVersionNo: number | null, discarded: number[] | undefined): number {
  const gone = (discarded ?? []).filter((n) => currentVersionNo === null || n > currentVersionNo).length
  return Math.max(0, pending - gone)
}

export type DiscardReply = { status: "discarded" | "already" | "refused"; message: string }

/** Put a not-applied version aside ("Discard"). The version stays in the list marked discarded; the current copy is not touched. */
export async function discardProposal(p: { fileId: string; versionNo: number; actor: string | null }): Promise<DiscardReply> {
  const { data: f, error: fErr } = await db().from("store_files").select("id, name, owner_id, folder_id, state, current_version_id").eq("id", p.fileId).maybeSingle()
  if (fErr) throw new Error(`discard: ${fErr.message}`)
  if (!f || f.state !== "live") return { status: "refused", message: "This file is not available." }
  const { data: v, error: vErr } = await db().from("store_file_versions").select("id, version_no, unmerged").eq("file_id", p.fileId).eq("version_no", p.versionNo).maybeSingle()
  if (vErr) throw new Error(`discard: ${vErr.message}`)
  if (!v) return { status: "refused", message: "That version no longer exists." }
  if (v.id === f.current_version_id || v.unmerged !== true) return { status: "refused", message: "Only a change that was not applied can be discarded." }
  const notes = await versionNotes(p.fileId)
  if (notes.get(v.id as string)?.discarded) return { status: "already", message: "That change was already discarded." }
  const { error } = await db().from("store_events").insert({
    event: "proposal_discarded", actor: p.actor, owner_id: f.owner_id, file_id: f.id, folder_id: f.folder_id, name_snapshot: f.name,
    details: { version_id: v.id, version_no: v.version_no },
  })
  if (error) throw new Error(`discard: ${error.message}`)
  return { status: "discarded", message: `The change (version ${v.version_no}) was discarded. The current copy was not changed, and the discarded version stays in the list.` }
}
