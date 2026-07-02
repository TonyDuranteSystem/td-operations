/**
 * Wizard background-job failure → client notification.
 *
 * Why this exists:
 * The portal wizard-submit route (app/api/portal/wizard-submit/route.ts) saves
 * the client's data and returns 200 IMMEDIATELY, then does the heavy work
 * (PDF generation, Drive upload, CRM updates, SD advance, emails) in a
 * background job. That fire-and-forget design fixed the false "Submission
 * failed" toast (Daniel Pasztor / Borisz / Zhang Holding), but it created a
 * blind spot: when the background job ultimately FAILS, the client already saw
 * the success screen and is left believing everything is fine, while the only
 * signal is the internal Exception Center.
 *
 * This module closes that blind spot. It is called from `failJob` (the single
 * chokepoint for FINAL job failure, after retries are exhausted) and posts a
 * plain, reassuring chat message into the client's portal so they know we have
 * their data and are handling the hiccup. Staff awareness is already covered by
 * the failed job in the Exception Center + this same message being visible in
 * the staff portal-chats inbox — we intentionally do NOT create a CRM task
 * (the team does not use the task board) and do NOT send an email (the goal is
 * an in-portal heads-up, matching the system-message design below).
 *
 * Guardrails (all verified against schema/code 2026-06-25):
 * - Fires ONLY for client-facing wizard job types (the values in the wizard-map
 *   JOB_TYPES). A failed invoice-reminder or doc-reprocess job must never tell a
 *   client "we had a problem with your submission".
 * - sender_type='system' + zero-UUID sender_id: blessed by migration
 *   20260518-2200 ("System messages are authored by the platform — e.g. when a
 *   client submits a wizard"). sender_id is NOT NULL but has no FK, so the
 *   sentinel is accepted (same pattern as lib/operations/formation-name-checks).
 *   The client chat read path (app/api/portal/chat/route.ts) shows system
 *   messages — it only hides ones carrying the `<!-- chat-event: -->` marker.
 * - sender_context is left NULL: it has a CHECK constraint
 *   (NULL | 'person' | 'company') and must NOT carry an idempotency marker.
 * - Idempotent: the per-job marker lives in job_queue.result.client_failure_notified
 *   (our own unconstrained JSONB), so a re-fire of failJob never double-posts and
 *   a later, genuinely-distinct failure is never wrongly suppressed.
 * - Never throws: a notification failure must never break `failJob` itself.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Json } from "@/lib/database.types"
import { JOB_TYPES } from "@/lib/portal/wizard-map"
import { localeFromLanguage } from "@/lib/locale"

/** Zero-UUID system sender — same sentinel the formation-name-checks system
 * path uses for platform-authored portal_messages (sender_id is NOT NULL but
 * has no FK constraint). */
const SYSTEM_SENDER_ID = "00000000-0000-0000-0000-000000000000"

/** Key written into job_queue.result to mark that the client was told. */
const NOTIFIED_FLAG = "client_failure_notified"

/**
 * Job types that originate from a client portal wizard submission. Derived from
 * the wizard-map so adding a new wizard job type automatically opts it in.
 * Today: formation_setup, onboarding_setup, tax_form_setup, tax_return_intake
 * (company_info), itin_wizard_setup. (tax + tax_return both map to
 * tax_form_setup; the Set dedupes them.)
 */
export const WIZARD_FAILURE_JOB_TYPES: ReadonlySet<string> = new Set(
  Object.values(JOB_TYPES).filter((v): v is string => typeof v === "string"),
)

export function isWizardFailureJobType(jobType: string): boolean {
  return WIZARD_FAILURE_JOB_TYPES.has(jobType)
}

// Canonical implementation moved to lib/locale.ts (2026-07-02) — re-exported
// so existing imports (ingest-complete-notify.ts and friends) keep working.
export { localeFromLanguage }

const MESSAGE: Record<"it" | "en", string> = {
  en: "We received your information, but ran into a technical issue while processing it. Our team has been notified and is handling it — no action is needed from you.",
  it: "Abbiamo ricevuto le tue informazioni, ma si è verificato un problema tecnico durante l'elaborazione. Il nostro team è stato avvisato e se ne sta occupando — non è richiesta alcuna azione da parte tua.",
}

/** Minimal shape of a job needed to notify the client. */
export interface WizardFailureJob {
  id: string
  job_type: string
  account_id?: string | null
  payload?: Record<string, unknown> | null
}

export interface WizardFailureNotifyResult {
  notified: boolean
  reason?: string
}

/**
 * Resolve the client's portal locale from the target contact / account.
 * Contact-scoped wizards (formation, ITIN) carry a contact_id; account-scoped
 * wizards (tax, onboarding, company_info) carry an account_id whose primary
 * linked contact's language we read. Defaults to English on any miss.
 */
async function resolveLocale(
  contactId: string | null,
  accountId: string | null,
): Promise<"it" | "en"> {
  try {
    if (contactId) {
      const { data } = await supabaseAdmin
        .from("contacts")
        .select("language")
        .eq("id", contactId)
        .maybeSingle()
      return localeFromLanguage(data?.language)
    }
    if (accountId) {
      // Prefer the primary contact; fall back to any linked contact.
      const { data: links } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id, is_primary")
        .eq("account_id", accountId)
      const rows = (links ?? []) as Array<{
        contact_id: string | null
        is_primary: boolean | null
      }>
      const chosen =
        rows.find((r) => r.is_primary && r.contact_id)?.contact_id ||
        rows.find((r) => r.contact_id)?.contact_id ||
        null
      if (chosen) {
        const { data } = await supabaseAdmin
          .from("contacts")
          .select("language")
          .eq("id", chosen)
          .maybeSingle()
        return localeFromLanguage(data?.language)
      }
    }
  } catch {
    // fall through to default
  }
  return "en"
}

/**
 * Post a client-facing failure chat message for a wizard background job that
 * has reached its FINAL failed state. Safe to call for any job — it self-gates
 * to wizard job types and never throws.
 */
export async function notifyClientOfWizardJobFailure(
  job: WizardFailureJob,
): Promise<WizardFailureNotifyResult> {
  try {
    if (!isWizardFailureJobType(job.job_type)) {
      return { notified: false, reason: "not_a_wizard_job" }
    }

    const payload = (job.payload ?? {}) as Record<string, unknown>
    const accountId =
      (job.account_id as string | null) ||
      (typeof payload.account_id === "string" ? payload.account_id : null)
    const contactId =
      typeof payload.contact_id === "string" ? payload.contact_id : null

    if (!accountId && !contactId) {
      return { notified: false, reason: "no_target" }
    }

    // Idempotency: per-job marker in job_queue.result (our own JSONB column).
    // A re-fire of failJob for the same job must not post a second message.
    const { data: jobRow } = await supabaseAdmin
      .from("job_queue")
      .select("result")
      .eq("id", job.id)
      .maybeSingle()
    const currentResult = (jobRow?.result ?? {}) as Record<string, unknown>
    if (currentResult[NOTIFIED_FLAG] === true) {
      return { notified: false, reason: "already_notified" }
    }

    const locale = await resolveLocale(contactId, accountId)

    const { error } = await supabaseAdmin.from("portal_messages").insert({
      account_id: accountId,
      contact_id: contactId,
      sender_type: "system",
      sender_id: SYSTEM_SENDER_ID,
      message: MESSAGE[locale],
    })
    if (error) {
      console.error(
        `[wizard-failure-notify] Insert failed for job ${job.id}:`,
        error.message,
      )
      return { notified: false, reason: "insert_failed" }
    }

    // Best-effort: stamp the marker so a re-fire skips. A failure here only
    // risks a duplicate message on the (practically impossible) double-fire —
    // it never breaks the notification that already succeeded.
    await supabaseAdmin
      .from("job_queue")
      .update({
        result: { ...currentResult, [NOTIFIED_FLAG]: true } as unknown as Json,
      })
      .eq("id", job.id)

    return { notified: true }
  } catch (e) {
    console.error(`[wizard-failure-notify] Unexpected error for job ${job.id}:`, e)
    return { notified: false, reason: "exception" }
  }
}
