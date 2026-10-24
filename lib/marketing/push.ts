/**
 * TD Marketing — notifications to the team's phones and computers (server; dev job 9aec66fa, Addendum G). Its own subscription table and its own sender: the staff push
 * table is for staff only and is never used for marketing logins. A dead subscription is removed when the push service says it is gone. VAPID keys are the site's
 * (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY); without them nothing is sent and nothing fails.
 */
import webpush from "web-push"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }
const DEAD = new Set([400, 401, 403, 404, 410])

export interface MarketingPushPayload { title: string; body: string; url: string; tag?: string }

/** Tell these people (by login id) on this team. Never throws: a failed notification must not fail the message that caused it. */
export async function sendMarketingPush(teamId: string, userIds: readonly string[], payload: MarketingPushPayload): Promise<{ sent: number; failed: number }> {
  const ids = Array.from(new Set(userIds.filter(Boolean)))
  if (ids.length === 0) return { sent: 0, failed: 0 }
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return { sent: 0, failed: 0 }
  try {
    webpush.setVapidDetails("mailto:support@tonydurante.us", pub, priv)
    const { data } = await db().from("marketing_push_subscriptions").select("id, endpoint, p256dh, auth_key").eq("team_id", teamId).in("user_id", ids)
    let sent = 0, failed = 0
    for (const s of (data ?? []) as Array<{ id: string; endpoint: string; p256dh: string; auth_key: string }>) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, JSON.stringify(payload))
        sent++
      } catch (e) {
        failed++
        const code = (e as { statusCode?: number })?.statusCode
        if (typeof code === "number" && DEAD.has(code)) await db().from("marketing_push_subscriptions").delete().eq("id", s.id)
      }
    }
    return { sent, failed }
  } catch {
    return { sent: 0, failed: 0 }
  }
}
