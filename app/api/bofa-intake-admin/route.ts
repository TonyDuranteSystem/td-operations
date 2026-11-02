/**
 * Staff-only (admin) routes for the Bank of America intake links.
 *   GET  /api/bofa-intake-admin            — list every link (no form answers)
 *   POST /api/bofa-intake-admin { partner_name } — create a new one-time link, returns its URL
 *
 * Kept under /api/bofa-intake-admin (NOT under the public /api/bank-application/ prefix) so the
 * middleware's session gate protects it. Where a finished application is submitted to is NOT chosen per link any more:
 * it is the Forms-card setting (lib/bofa-intake/settings.ts), read at the moment staff press Submit.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canUseForms } from "@/lib/auth"
import { bofaLinkUrl as linkUrl } from "@/lib/bofa-intake/url"
import { LIST_COLUMNS, readWithReviewColumns } from "@/lib/bofa-intake/columns"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

// Administrators plus the staff logins named in lib/auth/forms-access.ts (the same rule as the Forms menu item and page guard).
async function adminUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user && canUseForms(user) ? user : null
}

export async function GET() {
  if (!(await adminUser())) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const { data, error, reviewReady } = await readWithReviewColumns<unknown[]>(LIST_COLUMNS, (columns) =>
    table().select(columns).order("created_at", { ascending: false }).limit(200),
  )
  if (error) return NextResponse.json({ error: "Could not load the links." }, { status: 500 })
  return NextResponse.json({
    review_ready: reviewReady,
    links: (data ?? []).map((r) => ({ ...(r as { token: string }), url: linkUrl((r as { token: string }).token) })),
  })
}

export async function POST(req: NextRequest) {
  const user = await adminUser()
  if (!user) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const partner = typeof body.partner_name === "string" ? body.partner_name.trim().slice(0, 120) : ""

  const token = randomBytes(24).toString("base64url")
  const { data, error } = await table()
    .insert({ token, label: partner || "Direct", partner_name: partner || null, recipients: [], created_by: user.email ?? null })
    .select("id, token, label, partner_name, status, created_at")
    .single()
  if (error || !data) return NextResponse.json({ error: "Could not create the link." }, { status: 500 })
  return NextResponse.json({ link: { ...data, url: linkUrl(data.token) } })
}
