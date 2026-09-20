/**
 * GET  /api/itin-form/[token]/gate            — minimal info for the pre-code email gate
 * POST /api/itin-form/[token]/gate  { email }  — verify the typed email server-side, return the access code on match
 *
 * The email-gate landing page (app/itin-form/[token]/page.tsx) used to fetch
 * the FULL itin_submissions row with `select('*')` by token alone — no code
 * required at that stage — then compared the visitor's typed email against
 * `prefilled_data.email` IN THE BROWSER. The entire row (access_code,
 * prefilled_data, everything) was already sitting in the page's JS the
 * moment it loaded, before any email was typed or checked: the "gate" was
 * pure UI, not a real control. This route returns only what the gate needs
 * to render (language, completion state) and does the email comparison with
 * the service role, only ever handing back the access_code on a real match.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { clientIp } from "@/lib/esign/request-meta"
import { checkLoginRateLimit, recordLoginFailure, clearLoginFailures } from "@/lib/portal/rate-limit"

type Params = { params: Promise<{ token: string }> }

interface ItinGateRow {
  id: string
  access_code: string | null
  status: string
  language: "en" | "it" | null
  completed_at: string | null
  prefilled_data: Record<string, unknown> | null
}

async function loadRow(token: string) {
  const { data, error } = await supabaseAdmin
    .from("itin_submissions")
    .select("id, access_code, status, language, completed_at, prefilled_data")
    .eq("token", token)
    .maybeSingle()
  if (error || !data) return null
  return data as unknown as ItinGateRow
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const row = await loadRow(token)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Admin preview: a REAL staff session (never the query flag alone) may
  // jump straight to the code page, same as every other public form's
  // preview flow. Nobody else ever receives the access_code from this route.
  const previewRequested = req.nextUrl.searchParams.get("preview") === "td"
  const isAdmin = await isStaffPreview(previewRequested)

  return NextResponse.json({
    status: row.status,
    language: row.language ?? "en",
    completedAt: row.completed_at,
    accessCode: isAdmin ? row.access_code : null,
  })
}

export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 })

  const row = await loadRow(token)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Rate-limited the same way access_code guessing is elsewhere in this
  // codebase (lib/esign/access-guard.ts) — without this, the token alone
  // (guessable per lib/mcp/tools/itin-form.ts's slug+year scheme) plus
  // unlimited email guesses would let an attacker brute-force their way to
  // the real access_code, which this route hands back on a match.
  const key = `itin-gate:${clientIp(req) || "unknown"}:${token}`
  const rl = checkLoginRateLimit(key)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait a few minutes and try again." }, { status: 429 })
  }

  const prefillEmail = ((row.prefilled_data?.email as string) || "").trim().toLowerCase()
  if (!prefillEmail || email !== prefillEmail) {
    recordLoginFailure(key)
    // Deliberately generic — never confirm/deny whether an email exists on
    // file, and never echo the real email back.
    return NextResponse.json({ error: "Email does not match our records." }, { status: 403 })
  }
  clearLoginFailures(key)

  if (!row.access_code) {
    return NextResponse.json({ error: "This link is not ready yet." }, { status: 409 })
  }

  return NextResponse.json({ access_code: row.access_code })
}
