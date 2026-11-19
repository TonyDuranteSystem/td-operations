import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { CALENDLY_BOOKING_URL } from "@/lib/config"
import { decideRedirect } from "@/lib/booking/redirect"

/**
 * The address Antonio sends for a made Booking link: /r/b/<random id>. PUBLIC on purpose (no login: the person it is sent to is not signed in) — the page tells the
 * visitor nothing about whether an id exists; it only sends them on to Calendly, or to the normal booking page. All the rules are in lib/booking/redirect.ts.
 * `/r/` is already a public prefix in the middleware (the old referral redirect), so nothing there changes. `b` is a fixed folder, so it wins over the older /r/[code].
 */
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const decision = await decideRedirect(supabaseAdmin, id, { now: new Date(), userAgent: req.headers.get("user-agent") })
    if (decision.kind === "retry") {
      return new NextResponse("Please try again in a minute.", { status: 503, headers: { ...headers, "Retry-After": "30", "Content-Type": "text/plain; charset=utf-8" } })
    }
    return NextResponse.redirect(decision.location, { status: 302, headers })
  } catch (err) {
    // An unexpected failure must never strand a visitor: the normal booking page, as before this page existed.
    console.error("[booking redirect] unexpected failure:", err instanceof Error ? err.message : err)
    return NextResponse.redirect(CALENDLY_BOOKING_URL, { status: 302, headers })
  }
}
