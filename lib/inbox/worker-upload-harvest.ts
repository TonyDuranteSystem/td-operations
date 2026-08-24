/**
 * Files a staff member uploaded into a worker conversation in a RECENT prior
 * turn, still offered as attachable now — the twin of
 * lib/portal/chat-attachment-harvest.ts's harvestPortalChatAttachments, but
 * for the ASSISTANT's own upload history (Inbox / dashboard sidebar), not the
 * client's portal chat.
 *
 * WHY THIS EXISTS (dev job eefac886, Luca, 2026-08-24): a file's attach-ref
 * was built FRESH on every request from that ONE request's own upload list —
 * nothing carried it forward. A staff member who shared a file, then in a
 * LATER message asked to attach and send it, hit "not available this turn"
 * even though the file was sitting right there minutes earlier — reproduced
 * TWICE in one real conversation (Payset/Dragos, passport + utility bill).
 *
 * This widens the window: files uploaded in the last WORKER_UPLOAD_HARVEST_TURNS
 * turns of the SAME thread stay offered, with a FRESH server-minted ref every
 * time this runs — the model never gets to reuse a ref from an earlier turn,
 * only a real one this function re-offers THIS turn. Same trust boundary as
 * every other sendable source: the model names a ref, never a path.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

/** How many of the thread's most recent turns to look back through. */
export const WORKER_UPLOAD_HARVEST_TURNS = 12

/** One file recovered from a recent turn, in the shape sendableFromChatRefs-style helpers expect. */
export interface RecentWorkerUpload {
  id: string
  name?: string
  mimetype?: string
  size?: number
}

/**
 * The shape written into agent_messages.context_json.attachments at insert
 * time — see the write side in app/api/inbox/worker-chat/route.ts and
 * app/api/ai-agent/route.ts. Matches MaterializedAttachment's naming
 * (path/content_type), the convention already used for a persisted
 * attachment record elsewhere in this codebase (worker_prepared_sends).
 */
export interface PersistedTurnAttachment {
  path: string
  name?: string
  content_type?: string
  size?: number
}

/** Build the exact array to persist, from this turn's own upload refs. */
export function buildPersistedTurnAttachments(
  refs: Array<{ id: string; name?: string; mimetype?: string; size?: number }>,
): PersistedTurnAttachment[] {
  return refs
    .filter((r) => typeof r.id === "string" && r.id)
    .map((r) => ({ path: r.id, name: r.name, content_type: r.mimetype, size: r.size }))
}

/**
 * Look back over the last WORKER_UPLOAD_HARVEST_TURNS agent_messages rows for
 * this thread and return every file that was uploaded, newest first,
 * deduplicated by storage path (the same file shared twice counts once).
 * Excludes any path already in `excludePaths` — the CURRENT turn's own
 * uploads, which the caller already offers separately and fresher.
 *
 * Best-effort: any failure returns an empty list so the worker still answers
 * from what it has. Never throws.
 */
export async function harvestRecentWorkerUploads(
  threadId: string,
  excludePaths: Set<string>,
): Promise<RecentWorkerUpload[]> {
  if (!threadId) return []
  try {
    const { data, error } = await supabaseAdmin
      .from("agent_messages")
      .select("context_json")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(WORKER_UPLOAD_HARVEST_TURNS)
    if (error || !data) return []

    const seen = new Set<string>(excludePaths)
    const out: RecentWorkerUpload[] = []
    for (const row of data as Array<{ context_json?: unknown }>) {
      const ctx = row.context_json as { attachments?: unknown } | null
      const list = Array.isArray(ctx?.attachments) ? (ctx!.attachments as unknown[]) : []
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue
        const a = raw as Record<string, unknown>
        if (typeof a.path !== "string" || !a.path || seen.has(a.path)) continue
        seen.add(a.path)
        out.push({
          id: a.path,
          name: typeof a.name === "string" ? a.name : undefined,
          mimetype: typeof a.content_type === "string" ? a.content_type : undefined,
          size: typeof a.size === "number" ? a.size : undefined,
        })
      }
    }
    return out
  } catch {
    return []
  }
}
