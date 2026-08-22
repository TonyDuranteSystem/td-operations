/**
 * POST /api/system-errors/report — client-side error capture.
 *
 * Called fire-and-forget by CRM/portal UI when a fetch to our own API fails
 * in a way the UI cannot explain. Requires a logged-in user (middleware
 * already gates this path); dead-session failures therefore cannot self-report
 * — by design, because for those the middleware's 401 SESSION_EXPIRED body
 * already tells the client exactly what happened.
 *
 * ONE deliberate, narrow exception (2026-08-22, dev job 61f62c08): a Service
 * Worker's `push` event handler runs in the background and cannot be assumed
 * to carry a valid session — confirmed live, the portal SW's badge-failure
 * report was silently 401ing with nothing to show for it. Routes on
 * UNAUTH_ALLOWED_ROUTES skip the login check entirely; every other route is
 * completely unchanged (still requires auth, still 401s otherwise). The
 * allowlist must stay short and each entry must be a route this server
 * ALREADY KNOWS the exact shape of — this is not a general "report anything"
 * door. Unauthenticated reports are rate-limited per IP+route (see
 * lib/portal/rate-limit.ts) since nothing here identifies the caller, and are
 * capped by the same clampErrorInput() every path already goes through.
 *
 * DEDUP IS DELIBERATE, NOT INCIDENTAL, on the unauthenticated path (bug-hunter
 * adversarial review, same day): reportSystemError()'s dedup key includes the
 * free-text `message`, and that field is caller-supplied — an unauthenticated
 * caller could otherwise vary it per request to defeat dedup entirely and
 * flood the row list, burying the one real signal this exception exists to
 * surface. canonicalizeUnauthMessage() collapses the message down to one of a
 * FEW known shapes before it ever reaches reportSystemError() — an attacker
 * gets at most a handful of rows total, ever, no matter how many requests
 * they send. The exact text is not lost: it still lands in `context`, which
 * a human reads directly, just not in the dedup key. If a second allowlisted
 * route is ever added, it needs its own case here — do not widen the
 * catch-all to swallow a new route's real message variety.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { reportSystemError } from "@/lib/system-errors"
import { checkRateLimit, getRateLimitKey } from "@/lib/portal/rate-limit"

const UNAUTH_ALLOWED_ROUTES = new Set(["portal-sw:push:setAppBadge"])

function canonicalizeUnauthMessage(route: string, rawMessage: string): string {
  if (route === "portal-sw:push:setAppBadge") {
    if (rawMessage.startsWith("setAppBadge is not available")) return "setAppBadge unsupported in this context"
    if (rawMessage.startsWith("setAppBadge() rejected:")) return "setAppBadge() rejected"
    if (rawMessage.startsWith("setAppBadge() threw synchronously:")) return "setAppBadge() threw synchronously"
    return "setAppBadge: unrecognized outcome"
  }
  return rawMessage
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.route !== "string" || typeof body.message !== "string") {
      return NextResponse.json({ error: "route and message are required" }, { status: 400 })
    }

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    let message = body.message
    if (!user) {
      if (!UNAUTH_ALLOWED_ROUTES.has(body.route)) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 })
      }
      const { allowed } = checkRateLimit(getRateLimitKey(req), 20, 60_000)
      if (!allowed) {
        return NextResponse.json({ error: "Rate limited" }, { status: 429 })
      }
      // Canonicalize BEFORE it can influence the dedup fingerprint — see the
      // header comment. The raw text still rides in `context` below.
      message = canonicalizeUnauthMessage(body.route, body.message)
    }

    const context = body.context && typeof body.context === "object" ? body.context : null
    const result = await reportSystemError({
      source: "client",
      route: body.route,
      method: typeof body.method === "string" ? body.method : null,
      http_status: typeof body.http_status === "number" ? body.http_status : null,
      page_path: typeof body.page_path === "string" ? body.page_path : null,
      user_email: user?.email ?? null,
      message,
      body_snippet: typeof body.body_snippet === "string" ? body.body_snippet : null,
      context: user ? context : { ...(context ?? {}), raw_message: body.message.slice(0, 500) },
    })

    return NextResponse.json({ success: true, fingerprint: result?.fingerprint ?? null })
  } catch (err) {
    console.error("[system-errors/report] failed:", err)
    return NextResponse.json({ error: "Capture failed" }, { status: 500 })
  }
}
