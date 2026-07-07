/**
 * POST /api/system-errors/report — client-side error capture.
 *
 * Called fire-and-forget by CRM/portal UI when a fetch to our own API fails
 * in a way the UI cannot explain. Requires a logged-in user (middleware
 * already gates this path); dead-session failures therefore cannot self-report
 * — by design, because for those the middleware's 401 SESSION_EXPIRED body
 * already tells the client exactly what happened.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { reportSystemError } from "@/lib/system-errors"

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body.route !== "string" || typeof body.message !== "string") {
      return NextResponse.json({ error: "route and message are required" }, { status: 400 })
    }

    const result = await reportSystemError({
      source: "client",
      route: body.route,
      method: typeof body.method === "string" ? body.method : null,
      http_status: typeof body.http_status === "number" ? body.http_status : null,
      page_path: typeof body.page_path === "string" ? body.page_path : null,
      user_email: user.email ?? null,
      message: body.message,
      body_snippet: typeof body.body_snippet === "string" ? body.body_snippet : null,
      context: body.context && typeof body.context === "object" ? body.context : null,
    })

    return NextResponse.json({ success: true, fingerprint: result?.fingerprint ?? null })
  } catch (err) {
    console.error("[system-errors/report] failed:", err)
    return NextResponse.json({ error: "Capture failed" }, { status: 500 })
  }
}
