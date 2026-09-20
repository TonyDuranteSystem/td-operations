/**
 * GET  /api/formation-form/[token]/gate            — minimal info for the pre-code email gate
 * POST /api/formation-form/[token]/gate  { email }  — verify the typed email server-side, return the access code on match
 *
 * Same pattern as app/api/tax-form/[token]/gate/route.ts, adapted for
 * formation_submissions.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { clientIp } from "@/lib/esign/request-meta"
import { checkLoginRateLimit, recordLoginFailure, clearLoginFailures } from "@/lib/portal/rate-limit"

type Params = { params: Promise<{ token: string }> }

interface FormationFormGateRow {
  id: string
  access_code: string | null
  status: string
  language: "en" | "it" | null
  completed_at: string | null
  prefilled_data: Record<string, unknown> | null
}

async function loadRow(token: string) {
  const { data, error } = await supabaseAdmin
    .from("formation_submissions")
    .select("id, access_code, status, language, completed_at, prefilled_data")
    .eq("token", token)
    .maybeSingle()
  if (error || !data) return null
  return data as unknown as FormationFormGateRow
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const row = await loadRow(token)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const previewRequested = req.nextUrl.searchParams.get("preview") === "td"
  const isAdmin = await isStaffPreview(previewRequested)

  return NextResponse.json({
    status: row.status,
    language: row.language ?? "en",
    completedAt: row.completed_at,
    accessCode: isAdmin ? row.access_code : null,
    hasOwnerEmail: !!(row.prefilled_data?.owner_email as string | undefined),
  })
}

export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 })

  const row = await loadRow(token)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const key = `formation-form-gate:${clientIp(req) || "unknown"}:${token}`
  const rl = checkLoginRateLimit(key)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait a few minutes and try again." }, { status: 429 })
  }

  const prefillEmail = ((row.prefilled_data?.owner_email as string) || "").trim().toLowerCase()
  if (!prefillEmail || email !== prefillEmail) {
    recordLoginFailure(key)
    return NextResponse.json({ error: "Email does not match our records." }, { status: 403 })
  }
  clearLoginFailures(key)

  if (!row.access_code) {
    return NextResponse.json({ error: "This link is not ready yet." }, { status: 409 })
  }

  return NextResponse.json({ access_code: row.access_code })
}
