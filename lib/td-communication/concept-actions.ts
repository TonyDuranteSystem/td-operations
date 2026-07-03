/**
 * TD Communication — client concept responses (server-side, service role).
 *
 * The two client actions on a revealed brand concept: "I Love It" (approve) and
 * "Let's Discuss". Both post a system notice into the project's collaboration
 * conversation (the channel Cris/staff watch) — the client themselves never has
 * a seat in comm_messages, so the notice posts as SYSTEM_STAFF (the same sentinel
 * identity submitBrandAudit uses; comm_messages.sender_type allows only
 * staff/partner). Approve also advances the enrollment to 'approved'.
 *
 * td_comm_enrollments is RLS ON / NO policy — these run through supabaseAdmin
 * after the API authenticated the client + resolved THEIR OWN enrollment.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createConversation, insertMessage } from './queries'
import { SYSTEM_STAFF } from './brand-audit'
import { lockEarningIfEligible } from './earning'
import { resolveSubject } from './subject'
import type { CommEnrollmentRow } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** System chat notices (exported for consistency / tests). */
export const CONCEPT_APPROVED_MESSAGE = 'Client approved the concept'
export const CONCEPT_DISCUSS_MESSAGE = 'Client wants to discuss the concept'

/**
 * Return the enrollment's conversation id, creating + linking one (seeding
 * partner_id so Cris gets realtime) when it is still null. Idempotent: only
 * creates when missing. Mirrors submitBrandAudit's conversation seeding.
 */
export async function ensureEnrollmentConversation(
  enrollment: CommEnrollmentRow,
): Promise<string> {
  if (enrollment.conversation_id) return enrollment.conversation_id

  const subject = await resolveSubject(enrollment)
  const conv = await createConversation({
    subject: `Brand Concept — ${subject.name}`,
    partnerId: enrollment.partner_id ?? null,
    creator: SYSTEM_STAFF,
  })
  await db
    .from('td_comm_enrollments')
    .update({ conversation_id: conv.id, updated_at: new Date().toISOString() })
    .eq('id', enrollment.id)
  return conv.id
}

/**
 * Client approves the concept: forward-only optimistic flip to 'approved' (the
 * `.eq('status', current)` guard makes it a no-op under a concurrent edit), then
 * post the approval notice. The route already gated on canApproveConcept (only
 * from concept_ready), so the notice posts at most once per approval.
 */
export async function approveConcept(
  enrollment: CommEnrollmentRow,
): Promise<{ status: string; conversationId: string }> {
  const conversationId = await ensureEnrollmentConversation(enrollment)

  await db
    .from('td_comm_enrollments')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', enrollment.id)
    .eq('status', enrollment.status)

  // Phase 13: recognize Cris's earning on client approval (set-once, never throws).
  await lockEarningIfEligible(enrollment.id)

  await insertMessage({
    conversationId,
    sender: SYSTEM_STAFF,
    body: CONCEPT_APPROVED_MESSAGE,
  })

  return { status: 'approved', conversationId }
}

/**
 * Client asks to discuss the concept: no status change, just alert the team in
 * the project conversation. The client is then sent to /portal/chat (their own
 * channel) by the API/UI to actually type.
 */
export async function requestDiscussion(
  enrollment: CommEnrollmentRow,
): Promise<{ conversationId: string }> {
  const conversationId = await ensureEnrollmentConversation(enrollment)
  await insertMessage({
    conversationId,
    sender: SYSTEM_STAFF,
    body: CONCEPT_DISCUSS_MESSAGE,
  })
  return { conversationId }
}
