/**
 * Calendly webhook payload parser.
 *
 * Lives in lib/ (not the route file) so it can be unit-tested directly — Next.js
 * route modules may only export GET/POST/etc., not helper functions.
 *
 * Shape note (verified against a live booking 2026-05-27): real Calendly v2
 * webhooks place the invitee fields DIRECTLY on payload.payload (email, name,
 * questions_and_answers, tracking, scheduled_event). A synthetic test payload
 * once nested them under payload.payload.invitee — a wrapper that never appears
 * in real Calendly traffic. This parser accepts BOTH shapes.
 */

export interface ParsedInvitee {
  email: string
  name: string
  phone: string | null
  callDate: string | null
  reason: string | null
  referrerName: string | null
  referralCode: string | null
  eventUri: string | null
  eventTypeName: string | null
}

export function extractInviteeFields(
  payload: Record<string, unknown>
): ParsedInvitee | null {
  const p = ((payload.payload as Record<string, unknown>) || {}) as Record<string, unknown>
  // Prefer the nested invitee object if present (legacy/synthetic), otherwise read
  // the fields directly off payload.payload (real Calendly v2).
  const invitee = ((p.invitee as Record<string, unknown>) ?? p) as Record<string, unknown>
  if (!invitee?.email) return null

  const email = (invitee.email as string).toLowerCase().trim()
  const name = (invitee.name as string) || email.split("@")[0]
  const phone = (invitee.phone_number as string) || null

  let callDate: string | null = null
  const scheduledEvent = p.scheduled_event as Record<string, unknown> | undefined
  if (scheduledEvent?.start_time) {
    callDate = (scheduledEvent.start_time as string).split("T")[0]
  }

  const qAndA = invitee.questions_and_answers as
    | Array<{ question: string; answer: string }>
    | undefined
  let reason: string | null = null
  let referrerName: string | null = null
  if (qAndA?.length) {
    for (const qa of qAndA) {
      const q = qa.question.toLowerCase()
      if (q.includes("hear about") || q.includes("referral") || q.includes("come ci hai")) {
        referrerName = qa.answer || null
      } else if (q.includes("reason") || q.includes("motivo") || q.includes("help") || q.includes("interest")) {
        reason = qa.answer || null
      }
    }
    if (!reason && qAndA.length > 0 && !referrerName) {
      reason = qAndA[0].answer || null
    }
  }

  const eventUri = p.event as string | undefined

  // Referral code travels via the landing page's Calendly link. Calendly returns
  // UTM params in `tracking`; the `a1` prefill lands in questions_and_answers.
  const tracking = p.tracking as Record<string, unknown> | undefined
  let referralCode: string | null =
    (tracking?.utm_campaign as string) || (tracking?.utm_content as string) || null
  if (!referralCode && qAndA?.length) {
    // Fallback: an answer that looks like a legacy referral code (STEM-YYYY).
    for (const qa of qAndA) {
      if (/^[A-Z0-9]+-\d{4}(-\d+)?$/.test((qa.answer || "").trim())) {
        referralCode = qa.answer.trim()
        break
      }
    }
  }

  return {
    email,
    name,
    phone,
    callDate,
    reason,
    referrerName,
    referralCode,
    eventUri: eventUri || null,
    eventTypeName: (scheduledEvent?.name as string) || null,
  }
}
