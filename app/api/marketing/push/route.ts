import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }
const NO_STORE = { "Cache-Control": "no-store" }

/** GET /api/marketing/push — the site's public notification key (so the browser can subscribe). Only for marketing people with the chat. */
export async function GET() {
  const g = await requireMarketing("chat")
  if (g.res) return g.res
  const publicKey = process.env.VAPID_PUBLIC_KEY
  if (!publicKey) return NextResponse.json({ error: "Push not configured" }, { status: 503, headers: NO_STORE })
  return NextResponse.json({ publicKey }, { headers: NO_STORE })
}

/** POST /api/marketing/push { subscription } — this browser wants notifications for MY team. The team comes from the guard. */
export async function POST(req: NextRequest) {
  const g = await requireMarketing("chat")
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }
  const s = body.subscription
  if (typeof s?.endpoint !== "string" || !s.endpoint.startsWith("https://") || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400, headers: NO_STORE })
  }
  // one browser = one person: whoever subscribed this browser before (another login on a shared computer) is replaced, so notifications for him never land on this screen
  await db().from("marketing_push_subscriptions").delete().eq("endpoint", s.endpoint)
  const { error } = await db().from("marketing_push_subscriptions").insert({ team_id: g.ctx.team.id, user_id: g.ctx.user.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth_key: s.keys.auth })
  if (error) return NextResponse.json({ error: "Could not save the subscription." }, { status: 500, headers: NO_STORE })
  return NextResponse.json({ success: true }, { headers: NO_STORE })
}

/** DELETE /api/marketing/push { endpoint } — stop notifications on this device (only my own). */
export async function DELETE(req: NextRequest) {
  const g = await requireMarketing()
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { endpoint?: unknown }
  if (typeof body.endpoint !== "string") return NextResponse.json({ error: "endpoint required" }, { status: 400, headers: NO_STORE })
  await db().from("marketing_push_subscriptions").delete().eq("user_id", g.ctx.user.id).eq("endpoint", body.endpoint)
  return NextResponse.json({ success: true }, { headers: NO_STORE })
}
