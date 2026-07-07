/**
 * Duplicate-submission guard for portal wizard background jobs.
 *
 * Why: on 2026-07-07 a client whose uploads appeared stuck retried the tax
 * wizard submit 5 times in ~9 minutes. Each retry enqueued an identical
 * `tax_form_setup` job; all 5 ran to completion, each copying every file to
 * Drive again and emailing the team again (LT Program LLC incident #2).
 *
 * How: wizard-submit stamps every job payload with a `dedupe_key` — a hash of
 * the wizard type, the subject (account/contact/lead), and the submitted
 * data. Before enqueueing, it looks for a recent non-failed job with the same
 * key and reuses it instead of inserting a twin. A resubmission with ANY
 * changed field hashes differently and still enqueues normally.
 *
 * Known limits (accepted):
 * - Check-then-insert, not a DB constraint: two submits racing within the
 *   same few milliseconds can both pass. Real-world retries arrive seconds
 *   apart; a unique index can't express "non-failed within 24h" without
 *   status-driven key rewriting, which isn't worth the moving parts.
 * - Key stability relies on JSON.stringify key order, which is stable for
 *   retries of the same client code path (the only case that matters).
 */

import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const WIZARD_JOB_DEDUPE_WINDOW_HOURS = 24

/** Statuses that make an existing job count as "this work is already handled". */
const ACTIVE_JOB_STATUSES = ["pending", "processing", "completed"]

export function buildWizardJobDedupeKey(input: {
  wizardType: string
  accountId?: string | null
  contactId?: string | null
  leadId?: string | null
  data: Record<string, unknown>
}): string {
  const material = JSON.stringify({
    w: input.wizardType,
    a: input.accountId || null,
    c: input.contactId || null,
    l: input.leadId || null,
    d: input.data,
  })
  return createHash("sha256").update(material).digest("hex")
}

/**
 * Find a recent non-failed job carrying the same dedupe key. Returns null
 * when none exists — or when the lookup itself errors (default to enqueueing;
 * a duplicate job beats a silently dropped submission).
 */
export async function findRecentDuplicateJob(
  jobType: string,
  dedupeKey: string,
  windowHours: number = WIZARD_JOB_DEDUPE_WINDOW_HOURS,
): Promise<{ id: string; status: string } | null> {
  try {
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString()
    const { data, error } = await supabaseAdmin
      .from("job_queue")
      .select("id, status")
      .eq("job_type", jobType)
      .eq("payload->>dedupe_key", dedupeKey)
      .gte("created_at", since)
      .in("status", ACTIVE_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1)

    if (error) {
      console.warn(`[wizard-job-dedupe] lookup failed for ${jobType}: ${error.message}`)
      return null
    }
    return data?.[0] ?? null
  } catch (e) {
    console.warn(`[wizard-job-dedupe] lookup exception for ${jobType}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
