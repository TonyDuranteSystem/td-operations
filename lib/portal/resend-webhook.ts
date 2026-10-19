/**
 * Resend tells us AFTER an email was accepted whether it was delivered, delayed, bounced or blocked ("suppressed").
 * This file holds the pure rules (signature check, what an event means, what may overwrite what), so they are testable
 * without a database. The route is app/api/webhooks/resend/route.ts. Docs: resend.com/docs/webhooks.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type DeliveryStatus = 'delivered' | 'delayed' | 'not_delivered'

/** Svix signature (what Resend uses): HMAC-SHA256 of "<svix-id>.<svix-timestamp>.<raw body>" with the base64 part of the secret. */
export function verifySvixSignature(opts: {
  secret: string
  id: string | null
  timestamp: string | null
  signature: string | null
  payload: string
  nowMs?: number
  toleranceSec?: number
}): boolean {
  const { secret, id, timestamp, signature, payload } = opts
  if (!secret || !id || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const now = (opts.nowMs ?? Date.now()) / 1000
  if (Math.abs(now - ts) > (opts.toleranceSec ?? 300)) return false // stale or from the future: a replay
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest()
  // The header can hold several signatures: "v1,<base64> v1,<base64>".
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    const given = Buffer.from(sig, 'base64')
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}

export interface DeliveryUpdate {
  emailId: string
  status: DeliveryStatus
  detail: string | null
}

/** What an event means for the customer's inbox. Events that say nothing about delivery (opened, clicked, sent...) return null. */
export function interpretResendEvent(body: unknown): DeliveryUpdate | null {
  if (!body || typeof body !== 'object') return null
  const { type, data } = body as { type?: unknown; data?: { email_id?: unknown } }
  if (typeof type !== 'string' || !data || typeof data.email_id !== 'string' || !data.email_id) return null
  const emailId = data.email_id
  switch (type) {
    case 'email.delivered': return { emailId, status: 'delivered', detail: null }
    case 'email.delivery_delayed': return { emailId, status: 'delayed', detail: 'delayed' }
    case 'email.suppressed': return { emailId, status: 'not_delivered', detail: 'suppressed' }
    case 'email.bounced': return { emailId, status: 'not_delivered', detail: 'bounced' }
    case 'email.failed': return { emailId, status: 'not_delivered', detail: 'failed' }
    default: return null // complained, opened, clicked, sent, scheduled... do not change "did it arrive"
  }
}

/** Events can arrive out of order or twice. A real failure always sticks, "delivered" never erases it, "delayed" never overwrites an answer. */
export function shouldApplyDelivery(current: string | null, next: DeliveryStatus): boolean {
  if (next === 'not_delivered') return true
  if (current === 'not_delivered') return false
  if (next === 'delivered') return true
  return current === null || current === 'delayed' // delayed
}

// Kept here for callers/tests; the browser banner imports it from './delivery-reason' (this file uses server-only crypto).
export { deliveryReasonKey } from './delivery-reason'
