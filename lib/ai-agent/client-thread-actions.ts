/**
 * Close and reopen a client conversation — WITHOUT Slack.
 *
 * These two actions used to live in the Slack module: closing fetched the thread live
 * from Slack to freeze a snapshot, and both refreshed the "📌 Following" DM digests and
 * the shared Slack canvas. With the Slack surface gone (Antonio, 2026-07-30: "we don't
 * use Slack anymore… we built team workspace to replace Slack"), every one of those
 * calls would hit a workspace that is no longer there — so the CRM's Conversations page
 * would fail at exactly the moment a human clicks Close.
 *
 * What survives, because it is ours and not Slack's:
 *   - the snapshot, taken from the copy WE hold (`transcript`), which the rescue job
 *     filled from Slack while it still answered;
 *   - the memory feed, so a closed conversation still teaches the worker.
 *
 * What does not: the live Slack read and the follower digests/canvas.
 *
 * ONE BEHAVIOUR CHANGE, DELIBERATE AND NAMED: closing a conversation that was never
 * archived now freezes an EMPTY snapshot instead of pulling one from Slack. The
 * alternative — refusing to close — leaves staff unable to finish their work over a
 * conversation nobody can read anyway. The status is what the CRM acts on; the
 * transcript is a convenience.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface ClientThreadActionResult {
  ok: boolean
  error?: string
}

/** Freeze the conversation: status closed, snapshot kept, memory fed. */
export async function closeClientThread(
  id: string,
  closedBy?: string | null,
): Promise<ClientThreadActionResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row, error } = await db
    .from("client_threads")
    .select("source, source_ref, status, transcript, account_id, contact_id, lead_id, topic_slug")
    .eq("id", id)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!row) return { ok: false, error: "not found" }
  if (row.status === "closed") return { ok: true }

  // Our own copy IS the snapshot, already in the row — so closing writes the status
  // and NOTHING ELSE.
  //
  // Writing `transcript` back was a race with a destructive ending: the archive job
  // walks up to 500 conversations over several minutes, and a Close clicked in that
  // window would read an empty transcript, let the job write 40 real messages, then
  // overwrite them with []. Not touching the column removes the race entirely.
  const transcript: Array<{ author: string; text: string; ts: string }> = Array.isArray(row.transcript)
    ? row.transcript
    : []

  const { error: updateErr } = await db
    .from("client_threads")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: closedBy ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .neq("status", "closed")
  if (updateErr) return { ok: false, error: updateErr.message }

  // A CLOSED conversation is a human-confirmed record, so it feeds the worker's
  // memory — only closed ones, never live chatter. Best-effort: a memory that fails
  // to save must never leave the conversation half-closed.
  try {
    if (transcript.length > 0) {
      const entityId = row.account_id ?? row.contact_id ?? row.lead_id
      const kind = row.account_id ? "account" : row.contact_id ? "contact" : row.lead_id ? "lead" : null
      if (entityId && kind) {
        const topic = row.topic_slug ?? "general"
        const { saveDecisionMemory } = await import("./decision-memory")
        await saveDecisionMemory({
          situation: `Client conversation about ${topic}`,
          decision: transcript.map((m) => `${m.author}: ${m.text}`).join("\n").slice(0, 2000),
          domain: topic,
          sourceType: "client_thread_close",
          sourceRef: row.source_ref ?? undefined,
          clientKey: `${kind}:${entityId}`,
          confidence: 0.6,
          tags: ["client_thread", topic],
        })
      }
    }
  } catch (err) {
    console.warn("[client-thread-actions] memory feed failed (non-fatal):", err)
  }

  return { ok: true }
}

/**
 * Put the conversation back to live.
 *
 * THE SNAPSHOT IS KEPT — and this is a REVERSAL of the old behaviour, on purpose.
 *
 * Reopening used to null the transcript, which was right while Slack existed: the
 * conversation was live there, the page read it live, and a stale frozen copy sitting
 * behind it would have been served as though it were current. With Slack gone that
 * same line becomes destructive — the stored copy is now the ONLY copy, so clearing it
 * on a single click would erase the conversation permanently, with nowhere to re-read
 * it from. Reopen changes the STATUS; it must not throw away the history.
 */
export async function reopenClientThread(id: string): Promise<ClientThreadActionResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { error } = await db
    .from("client_threads")
    .update({ status: "open", closed_at: null, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
