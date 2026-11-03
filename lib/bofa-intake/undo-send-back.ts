/**
 * Bank application intake — "Undo send back" (Antonio 2026-11-03: build both left-over items after the bug hunt).
 *
 * Send back (send-back.ts) marks the application as sent back and makes a NEW one-time link. If staff pressed it by mistake, this
 * puts things right: the new link is cancelled and the application goes back to exactly where it was (Reviewed, Submitted… — those
 * columns are never touched by a send-back, only the three "returned" ones are).
 *
 * It only works while nobody is working on the new link (never opened, or already revoked — see undoSendBackBlock). Order matters:
 *   1. cancel the new link with an atomic "only while still not opened" update, so a client who presses Start at the same moment
 *      wins and the undo is refused instead of throwing their uploads away;
 *   2. put the application back with an atomic "only if it is still sent back by that same send-back" update, so a second staff
 *      member's "Send back again" in between is never overwritten.
 * If step 2 fails after step 1 the application is simply "sent back with nobody waiting" — a valid state staff can undo again or
 * send back again. Nothing is emailed: the client keeps any email they already got, and its link now says it is no longer active.
 * The note the staff wrote stays on the cancelled link's row (`staff_note`), so what was asked is still on record.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { reviewState, undoSendBackBlock } from "./review-state"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

export type UndoSendBackResult = { ok: true; cancelledLink: boolean } | { ok: false; error: string }

export async function undoSendBack(id: string): Promise<UndoSendBackResult> {
  const { data: row, error: readErr } = await table()
    .select("id, status, email_status, reviewed_at, returned_at")
    .eq("id", id)
    .maybeSingle()
  if (readErr || !row) return { ok: false, error: "Application not found." }
  if (reviewState(row) !== "sent_back") return { ok: false, error: "This application is not sent back, so there is nothing to undo." }

  const { data: replacements, error: repErr } = await table().select("id, status").eq("replaces_id", id)
  if (repErr) return { ok: false, error: "Could not check the new link. Please try again." }
  const blocked = undoSendBackBlock(replacements ?? [])
  if (blocked) return { ok: false, error: blocked }

  // 1. cancel the new link — only while the client has not opened it
  const live = (replacements ?? []).find((x: { status: string }) => x.status !== "revoked") as { id: string } | undefined
  if (live) {
    const { data: cancelled, error: cancelErr } = await table()
      .update({ status: "revoked", updated_at: new Date().toISOString() })
      .eq("id", live.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle()
    if (cancelErr) return { ok: false, error: "Could not cancel the new link. Nothing was changed." }
    if (!cancelled) return { ok: false, error: "The client just opened the new link, so it cannot be cancelled here. Reload the page." }
  }

  // 2. put the application back, only if it is still the same send-back we looked at
  const { data: restored, error: restoreErr } = await table()
    .update({ returned_at: null, returned_by: null, return_note: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "completed")
    .eq("returned_at", row.returned_at)
    .select("id")
    .maybeSingle()
  if (restoreErr || !restored) {
    return {
      ok: false,
      error: live
        ? "The new link was cancelled, but the application could not be put back. Reload the page and press Undo send back again."
        : "This application changed while you were looking at it. Reload the page and try again.",
    }
  }
  return { ok: true, cancelledLink: !!live }
}
