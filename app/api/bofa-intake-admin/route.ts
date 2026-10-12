/**
 * Staff-only (admin) routes for the Bank of America intake links.
 *   GET  /api/bofa-intake-admin            — list every link (no form answers)
 *   POST /api/bofa-intake-admin { label }  — create a new one-time link, returns its URL
 *
 * Kept under /api/bofa-intake-admin (NOT under the public /api/bank-application/ prefix) so the
 * middleware's session gate protects it.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isSecureAdmin } from "@/lib/auth"
import { bofaLinkUrl as linkUrl } from "@/lib/bofa-intake/url"
import { parseRecipients } from "@/lib/bofa-intake/recipients"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

async function adminUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user && isSecureAdmin(user) ? user : null
}

export async function GET() {
  if (!(await adminUser())) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const { data, error } = await table()
    .select("id, token, label, partner_name, recipients, email_status, email_sent_at, email_error, status, opened_at, completed_at, created_at, created_by, notified_at, store_owner_id, store_folder_id, store_archived_at, store_error, client_name:form_data->>full_name, client_company:form_data->>company_name")
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: "Could not load the links." }, { status: 500 })
  return NextResponse.json({
    links: (data ?? []).map((r: { token: string }) => ({ ...r, url: linkUrl(r.token) })),
  })
}

export async function POST(req: NextRequest) {
  const user = await adminUser()
  if (!user) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const partner = typeof body.partner_name === "string" ? body.partner_name.trim().slice(0, 120) : ""
  const parsed = parseRecipients(body.recipients)
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const token = randomBytes(24).toString("base64url")
  const { data, error } = await table()
    .insert({ token, label: partner || "Direct", partner_name: partner || null, recipients: parsed.emails, created_by: user.email ?? null })
    .select("id, token, label, partner_name, recipients, status, created_at")
    .single()
  if (error || !data) return NextResponse.json({ error: "Could not create the link." }, { status: 500 })
  return NextResponse.json({ link: { ...data, url: linkUrl(data.token) } })
}
