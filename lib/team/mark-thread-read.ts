import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Advance a user's read pointer for a Team Workspace thread. The ONE place
 * this write happens — app/api/team/threads/[id]/read/route.ts and the Staff
 * Alerts chat-dismiss PATCH (app/api/crm/staff-alerts/route.ts) both call
 * this instead of each hand-rolling the same upsert, so they cannot drift
 * (a future side effect — an audit row, a presence update — lands for both
 * callers automatically instead of silently only one).
 */
export async function markThreadRead(userId: string, threadId: string): Promise<string | null> {
  const nowIso = new Date().toISOString()
  // internal_thread_reads is not in the generated Database types yet — same
  // escape hatch used throughout this route family.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from("internal_thread_reads")
    .upsert(
      { thread_id: threadId, user_id: userId, last_read_at: nowIso, manual_unread: false, updated_at: nowIso },
      { onConflict: "thread_id,user_id" },
    )
  return error ? error.message : null
}
