/**
 * TD Marketing — notifications to the team's phones and computers (server; dev job 9aec66fa, Addendum G). Its own subscription table and its own sender: the staff push
 * table is for staff only and is never used for marketing logins. A dead subscription is removed when the push service says it is gone. VAPID keys are the site's
 * (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY); without them nothing is sent and nothing fails.
 */
import webpush from "web-push"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { MarketingAlertKind } from "@/lib/push/alert-kinds"
import { startPhoneLeg, waitForPhoneLeg } from "@/lib/app/phone-leg"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }
const DEAD = new Set([400, 401, 403, 404, 410])

/** `alertKind` is required (lib/push/alert-kinds.ts): what kind of alert this is. It is removed before the web send; the phone leg (TD Social, pull request C2) reads it. */
export interface MarketingPushPayload { title: string; body: string; url: string; tag?: string; alertKind: MarketingAlertKind; phoneName?: string; leadId?: string }

/** Tell these people (by login id) on this team. Never throws: a failed notification must not fail the message that caused it. */
export async function sendMarketingPush(teamId: string, userIds: readonly string[], payload: MarketingPushPayload): Promise<{ sent: number; failed: number }> {
  const ids = Array.from(new Set(userIds.filter(Boolean)))
  if (ids.length === 0) return { sent: 0, failed: 0 }
  const { alertKind, phoneName, leadId, ...wire } = payload // the label, the lock-screen name and the lead are not part of what the browser receives
  // TD Social phones (pull request C2): starts first, before the early return below, beside the web send; does nothing without the Apple key and the TD Social switch, never throws.
  const phone = startPhoneLeg({ source: "marketing", teamId, userIds: ids, kind: alertKind, title: payload.title, body: payload.body, url: payload.url, tag: payload.tag, name: phoneName, dm: false, leadId })
  try {
    return await sendMarketingWeb(ids, teamId, wire)
  } finally {
    await waitForPhoneLeg(phone)
  }
}

/** The web send to the team's browsers, unchanged from before the phone leg existed (the same body, now one step down). */
async function sendMarketingWeb(ids: string[], teamId: string, wire: Omit<MarketingPushPayload, "alertKind" | "phoneName" | "leadId">): Promise<{ sent: number; failed: number }> {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return { sent: 0, failed: 0 }
  try {
    webpush.setVapidDetails("mailto:support@tonydurante.us", pub, priv)
    const { data } = await db().from("marketing_push_subscriptions").select("id, endpoint, p256dh, auth_key").eq("team_id", teamId).in("user_id", ids)
    let sent = 0, failed = 0
    // all at once, each with its own time limit: one slow or dead address must not hold up the others
    await Promise.allSettled(((data ?? []) as Array<{ id: string; endpoint: string; p256dh: string; auth_key: string }>).map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, JSON.stringify(wire), { timeout: 8000 })
        sent++
      } catch (e) {
        failed++
        const code = (e as { statusCode?: number })?.statusCode
        if (typeof code === "number" && DEAD.has(code)) await db().from("marketing_push_subscriptions").delete().eq("id", s.id)
      }
    }))
    return { sent, failed }
  } catch {
    return { sent: 0, failed: 0 }
  }
}
