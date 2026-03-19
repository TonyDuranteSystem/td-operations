import webpush from 'web-push'
import { supabaseAdmin } from '@/lib/supabase-admin'

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

/**
 * Send push notification to all subscriptions for an account
 */
export async function sendPushToAccount(
  accountId: string,
  payload: { title: string; body: string; url?: string; tag?: string }
) {
  try {
    initWebPush()
  } catch {
    // VAPID keys not set — skip push silently
    return { sent: 0, failed: 0 }
  }

  const { data: subscriptions } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth_key')
    .eq('account_id', accountId)

  if (!subscriptions?.length) return { sent: 0, failed: 0 }

  let sent = 0
  let failed = 0

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth_key,
          },
        },
        JSON.stringify(payload)
      )
      sent++
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode
      // 410 Gone or 404 — subscription expired, remove it
      if (statusCode === 410 || statusCode === 404) {
        await supabaseAdmin
          .from('push_subscriptions')
          .delete()
          .eq('id', sub.id)
      }
      failed++
    }
  }

  return { sent, failed }
}

/**
 * Get the VAPID public key for client-side subscription
 */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null
}
