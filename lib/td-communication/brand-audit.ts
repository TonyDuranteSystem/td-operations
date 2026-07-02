/**
 * TD Communication — brand-audit wizard intake (server-side, service role).
 *
 * The portal `td_communication` wizard has NO submission table and NO
 * background job: its canonical record is the `td_comm_enrollments` row. This
 * module is the connection between the wizard submit and that row —
 * find/create the enrollment, fill its form_data, advance it to
 * `form_submitted`, and announce the submission in the project's collaboration
 * chat (the channel Cris watches).
 *
 * Like the rest of td-communication, `td_comm_enrollments` is RLS ON with NO
 * policy — all access is through supabaseAdmin (RLS bypass) after the API layer
 * authenticated + authorized the caller (wizard-submit's canSubmitWizard gate).
 *
 * The pure decision helpers (no DB) live at the top and are unit-tested in
 * tests/unit/td-communication-brand-audit.test.ts.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createConversation, insertMessage, SYSTEM_STAFF } from './queries'
import { ensureDeadlineAt } from './sla'
import type { CommEnrollmentRow, EnrollmentClientType } from './types'

// SYSTEM_STAFF moved to ./queries (the neutral hub) to avoid an import cycle with
// ./sla; re-exported here so existing importers (e.g. concept-actions) still resolve it.
export { SYSTEM_STAFF } from './queries'

// ── Pure helpers (no DB — unit-tested) ──────────────────────────────────────

/** Terminal enrollment statuses — an audit for one of these is "done"; a new
 *  submission should never attach to it (look past it / create a fresh row). */
export function isTerminalEnrollmentStatus(status: string): boolean {
  return status === 'delivered' || status === 'cancelled'
}

/** Coerce a raw client_type value (e.g. the wizard's entity_type) to a valid
 *  EnrollmentClientType. Anything other than 'rebrand' defaults to 'new_brand'
 *  — the safe default for a self-serve client with no staff-set type. */
export function normalizeClientType(raw: unknown): EnrollmentClientType {
  return raw === 'rebrand' ? 'rebrand' : 'new_brand'
}

/** The client's business name from the brand-audit answers. The DB-driven
 *  question set stores it under `brand_name` (Step 3); the legacy placeholder
 *  used `business_name`. Accept both, then fall back to a neutral label for the
 *  chat notice. */
export function businessNameFromFormData(data: Record<string, unknown>): string {
  const raw = data?.business_name ?? data?.brand_name
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'New brand'
}

/** The system chat notice posted when a brand audit is submitted. */
export function brandAuditSubmittedMessage(businessName: string): string {
  return `New brand audit submitted: ${businessName}`
}

/**
 * Pick the client's active enrollment from candidate rows (already filtered to
 * this client's subjects). Prefer the NEWEST non-terminal row. Returns null
 * when none qualifies. Pure so the precedence is unit-testable.
 */
export function pickActiveClientEnrollment(
  rows: CommEnrollmentRow[],
): CommEnrollmentRow | null {
  const active = rows.filter((r) => !isTerminalEnrollmentStatus(r.status))
  if (active.length === 0) return null
  return active.reduce((newest, r) =>
    r.created_at > newest.created_at ? r : newest,
  )
}

// ── DB-backed (service role) ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const ENROLLMENT_COLUMNS =
  'id, account_id, contact_id, lead_id, partner_id, service_delivery_id, client_type, package_slug, status, form_data, conversation_id, metadata, deadline_at, created_at, updated_at'

/**
 * The client's active (non-terminal) brand-audit enrollment, looked up by the
 * WHOLE client identity — their contact OR any of their accounts — so a
 * staff-created enrollment is found regardless of which subject column it uses.
 * Returns null when none exists. Used by both the portal CTA and the submit.
 */
export async function getClientActiveEnrollment(
  contactId: string | null,
  accountIds: string[],
): Promise<CommEnrollmentRow | null> {
  const orClauses: string[] = []
  if (contactId) orClauses.push(`contact_id.eq.${contactId}`)
  if (accountIds.length > 0) orClauses.push(`account_id.in.(${accountIds.join(',')})`)
  if (orClauses.length === 0) return null

  const { data, error } = await db
    .from('td_comm_enrollments')
    .select(ENROLLMENT_COLUMNS)
    .not('status', 'in', '(delivered,cancelled)')
    .or(orClauses.join(','))
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)

  return pickActiveClientEnrollment((data ?? []) as CommEnrollmentRow[])
}

export interface SubmitBrandAuditParams {
  /** Logged-in client's contact id (null for a teammate identity). */
  contactId: string | null
  /** The selected account id — used as the subject when CREATING a new
   *  enrollment for a company client. Null for an individual/contact client. */
  subjectAccountId: string | null
  /** All of the client's account ids — used to FIND an existing enrollment. */
  accountIds: string[]
  /** Brand-audit path the wizard ran ('new_brand' | 'rebrand'). */
  clientType: EnrollmentClientType
  /** The wizard answers. */
  formData: Record<string, unknown>
}

/**
 * Connect a brand-audit submission to its enrollment: find-or-create the row,
 * ensure a project conversation exists (idempotent), store the answers, advance
 * status to 'form_submitted', and post the submission notice in the chat.
 * Returns the enrollment + conversation ids. Throws on a hard DB error so the
 * route surfaces it (R099).
 */
export async function submitBrandAudit(
  params: SubmitBrandAuditParams,
): Promise<{ enrollmentId: string; conversationId: string | null }> {
  const { contactId, subjectAccountId, accountIds, clientType, formData } = params

  // 1. Find the existing enrollment by identity, or create a fresh one.
  let enrollment = await getClientActiveEnrollment(contactId, accountIds)
  if (!enrollment) {
    const subject = subjectAccountId
      ? { account_id: subjectAccountId }
      : contactId
        ? { contact_id: contactId }
        : null
    if (!subject) throw new Error('Cannot create brand-audit enrollment: no account or contact subject')
    const { data: created, error: createErr } = await db
      .from('td_comm_enrollments')
      .insert({ ...subject, client_type: clientType, status: 'enrolled' })
      .select(ENROLLMENT_COLUMNS)
      .single()
    if (createErr) throw new Error(createErr.message)
    enrollment = created as CommEnrollmentRow
  }

  const businessName = businessNameFromFormData(formData)

  // 2. Ensure a project conversation exists (idempotent — only when missing).
  let conversationId = enrollment.conversation_id
  if (!conversationId) {
    const conv = await createConversation({
      subject: `Brand Audit — ${businessName}`,
      partnerId: enrollment.partner_id ?? null,
      creator: SYSTEM_STAFF,
    })
    conversationId = conv.id
  }

  // 3. Store the answers, advance status, stamp form_submitted_at, link convo.
  const formSubmittedAt = new Date().toISOString()
  const mergedMetadata = {
    ...(enrollment.metadata ?? {}),
    form_submitted_at: formSubmittedAt,
  }
  const { error: updateErr } = await db
    .from('td_comm_enrollments')
    .update({
      form_data: formData,
      status: 'form_submitted',
      conversation_id: conversationId,
      metadata: mergedMetadata,
      updated_at: formSubmittedAt,
    })
    .eq('id', enrollment.id)
  if (updateErr) throw new Error(updateErr.message)

  // 3b. Set the SLA deadline (= form_submitted_at + package.delivery_days) the
  // first time the audit is submitted. Idempotent + never throws (Phase 10).
  await ensureDeadlineAt(enrollment.id, formSubmittedAt)

  // 4. Announce the submission in the project chat.
  await insertMessage({
    conversationId,
    sender: SYSTEM_STAFF,
    body: brandAuditSubmittedMessage(businessName),
  })

  return { enrollmentId: enrollment.id, conversationId }
}
