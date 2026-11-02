/**
 * Bank application intake — the "Reviewed" button (Antonio 2026-11-02: "one reviewed, by us"). Marks a submitted application
 * as looked at, which is what enables Submit. One atomic UPDATE: it only matches an application that has been submitted by
 * the client, not yet reviewed, not sent back and not already submitted, so a double click or a stale page does nothing twice.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

export type ReviewResult = { ok: true } | { ok: false; error: string }

export async function markReviewed(id: string, by: string): Promise<ReviewResult> {
  const now = new Date().toISOString()
  const { data, error } = await table()
    .update({ reviewed_at: now, reviewed_by: by, updated_at: now })
    .eq("id", id)
    .eq("status", "completed")
    .is("reviewed_at", null)
    .is("returned_at", null)
    // anything except a finished send (a plain "not equal" would skip rows with no email_status at all)
    .or("email_status.is.null,email_status.neq.sent")
    .select("id")
    .maybeSingle()
  if (error) return { ok: false, error: "Could not mark it Reviewed. Please try again." }
  if (!data) return { ok: false, error: "That application cannot be marked Reviewed: it is already reviewed, submitted or sent back. Reload the page." }
  return { ok: true }
}
