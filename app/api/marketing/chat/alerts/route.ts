import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { adminMemberContext, resolveMarketingContext } from "@/lib/marketing/guard"
import { chatAlerts } from "@/lib/marketing/chat-alerts"
import { baselineFrom, sinceFrom } from "@/lib/marketing/voice-alert"
import { NO_STORE } from "@/lib/marketing/lead-chat-server"

export const dynamic = "force-dynamic"

/**
 * GET /api/marketing/chat/alerts?since=<time> — what the spoken alert ("Message from Rocco") should read out: who wrote to me since that time and I have not read yet. Without a usable time it only returns
 * the server's clock (the page starts from it, so switching Sound on never reads out old messages). Antonio is asked as HIMSELF wherever he is in the CRM, never as a role he is "viewing as": that choice
 * is a cookie that can outlive the screen it was for. A login that is not part of a team gets 401/403 and the page stops asking.
 */
export async function GET(req: NextRequest) {
  // the clock is taken FIRST, before the login checks (which can be slow under load): a message written while they run is found by the next look
  const now = new Date()
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: NO_STORE })
  const g = isSecureAdmin(user) ? await adminMemberContext({ id: user.id, email: user.email }) : await resolveMarketingContext()
  if (g.ok === false) return NextResponse.json({ error: g.message, code: g.code }, { status: g.status, headers: NO_STORE })
  const since = sinceFrom(req.nextUrl.searchParams.get("since"), now)
  if (!since) return NextResponse.json({ now: baselineFrom(now), items: [] }, { headers: NO_STORE })
  return NextResponse.json({ now: now.toISOString(), items: await chatAlerts(g.ctx, since) }, { headers: NO_STORE })
}
