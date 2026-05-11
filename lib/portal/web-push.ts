import webpush from 'web-push'
import { supabaseAdmin } from '@/lib/supabase-admin'

// Status codes that mean the push subscription is permanently dead and
// must be removed. Excludes 408 (timeout) and 429 (rate-limit) — those
// are transient and the subscription is still valid.
const DEAD_SUBSCRIPTION_STATUS_CODES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 410,
])

type PushSubscriptionTable = 'push_subscriptions' | 'admin_push_subscriptions'

type StoredSubscription = {
  id: string
  endpoint: string
  p256dh: string
  auth_key: string
}

type PushPayload = { title: string; body: string; url?: string; tag?: string }

function getVapidKeys() {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    throw new Error('VAPID keys not configured')
  }
  return { publicKey, privateKey }
}

function initWebPush() {
  const { publicKey, privateKey } = getVapidKeys()
  webpush.setVapidDetails(
    'mailto:support@tonydurante.us',
    publicKey,
    privateKey
  )
}

function isDeadSubscription(statusCode: number | undefined): boolean {
  return typeof statusCode === 'number' && DEAD_SUBSCRIPTION_STATUS_CODES.has(statusCode)
}

/**
 * Send the payload to each subscription, delete dead subs, log failures.
 */
async function deliverPushBatch(
  table: PushSubscriptionTable,
  subscriptions: StoredSubscription[],
  payload: PushPayload,
  context: string,
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_key },
        },
        JSON.stringify(payload),
      )
      sent++
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode
      const message = err instanceof Error ? err.message : String(err)
      console.error('[web-push] send failed', {
        context,
        statusCode,
        endpoint: sub.endpoint.slice(0, 80),
        message,
      })
      if (isDeadSubscription(statusCode)) {
        await supabaseAdmin.from(table).delete().eq('id', sub.id)
      }
      failed++
    }
  }

  if (failed > 0) {
    console.error(
      `[web-push] ${context}: ${sent} sent, ${failed} failed of ${subscriptions.length} subscriptions`,
    )
  }

  return { sent, failed }
}

/**
 * Send push notification to all subscriptions for an account
 */
export async function sendPushToAccount(
  accountId: string,
  payload: PushPayload,
) {
  try {
    initWebPush()
  } catch {
    return { sent: 0, failed: 0 }
  }

  const { data: subscriptions } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth_key')
    .eq('account_id', accountId)

  if (!subscriptions?.length) return { sent: 0, failed: 0 }

  return deliverPushBatch('push_subscriptions', subscriptions, payload, `account:${accountId}`)
}

/**
 * Send push notification to all subscriptions for a contact (no account needed).
 * Used for ITIN clients and contacts without LLCs.
 */
export async function sendPushToContact(
  contactId: string,
  payload: PushPayload,
) {
  try {
    initWebPush()
  } catch {
    return { sent: 0, failed: 0 }
  }

  const { data: subscriptions } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth_key')
    .eq('contact_id', contactId)

  if (!subscriptions?.length) return { sent: 0, failed: 0 }

  return deliverPushBatch('push_subscriptions', subscriptions, payload, `contact:${contactId}`)
}

/**
 * Send push notification to all admin subscriptions
 */
export async function sendPushToAdmin(payload: PushPayload) {
  try {
    initWebPush()
  } catch {
    return { sent: 0, failed: 0 }
  }

  const { data: subscriptions } = await supabaseAdmin
    .from('admin_push_subscriptions')
    .select('id, endpoint, p256dh, auth_key')

  if (!subscriptions?.length) return { sent: 0, failed: 0 }

  return deliverPushBatch('admin_push_subscriptions', subscriptions, payload, 'admin')
}

/**
 * Send push notification to all admin subscriptions except a specific user.
 * Used for team-to-team messages so the sender doesn't notify themselves.
 */
export async function sendPushToAdminExcluding(
  excludeUserId: string,
  payload: PushPayload,
) {
  try {
    initWebPush()
  } catch {
    return { sent: 0, failed: 0 }
  }

  const { data: subscriptions } = await supabaseAdmin
    .from('admin_push_subscriptions')
    .select('id, endpoint, p256dh, auth_key')
    .neq('user_id', excludeUserId)

  if (!subscriptions?.length) return { sent: 0, failed: 0 }

  return deliverPushBatch(
    'admin_push_subscriptions',
    subscriptions,
    payload,
    `admin-excluding:${excludeUserId}`,
  )
}

/**
 * Get the VAPID public key for client-side subscription
 */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null
}
