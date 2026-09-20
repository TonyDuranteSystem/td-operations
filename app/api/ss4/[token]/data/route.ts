/**
 * GET   /api/ss4/[token]/data?code=...&preview=td   — fetch the SS-4 record for the signing page
 * PATCH /api/ss4/[token]/data                       — track-open, or record a signature
 *   body: { code, preview?, action: "track_open" | "sign", signature_data_url?, signed_name? }
 *
 * `code` is a QUERY param / body field, not a path segment — a [code] path
 * segment sibling of the existing literal "pdf" / "upload-signed" segments
 * under [token] is an invalid Next.js route (static + dynamic siblings),
 * and this also matches how /api/ss4/[token]/pdf already takes ?code=.
 *
 * Replaces the SS-4 signing page's direct anon-key browser queries against
 * ss4_applications. The old page trusted a client-supplied `.eq("token", ...)`
 * filter; the table's RLS policy allowed the anon role's SELECT/UPDATE
 * unconditionally, so a request that skipped that filter (or hit the REST API
 * directly) could read or rewrite ANY application, including the ability to
 * forge a "signed" status without ever drawing a signature. This route does
 * the token+code check server-side (service role) so the anon grant can be
 * revoked. See lib/public-forms/verify-token-access.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { verifyTokenAccess } from "@/lib/public-forms/verify-token-access"

type Params = { params: Promise<{ token: string }> }

interface Ss4Row {
  id: string
  access_code: string | null
  status: string
  company_name: string
  responsible_party_name: string | null
  view_count: number | null
  [key: string]: unknown
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const code = req.nextUrl.searchParams.get("code")
  const preview = req.nextUrl.searchParams.get("preview") === "td"

  const access = await verifyTokenAccess<Ss4Row>("ss4_applications", "*", token, code, preview)
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  return NextResponse.json({ data: access.row, isAdmin: access.isAdmin })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const code = body.code ?? null
  const preview = body.preview === "td"

  const access = await verifyTokenAccess<Ss4Row>(
    "ss4_applications",
    "id, access_code, status, view_count",
    token,
    code,
    preview,
  )
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  if (body.action === "track_open") {
    // Mirrors the page's prior client-side behavior EXACTLY: bump view_count
    // and viewed_at only. Deliberately does NOT touch status — the page's own
    // long-standing comment says why: promoting draft to awaiting_signature
    // (or any other status change) just because the page was opened let a
    // draft be signed by anyone holding the link, and undid a staff signer
    // switch the moment the previous signer's old link was merely opened.
    // Status changes here are a real correctness regression, not a style
    // choice — this route must stay a pure view-tracking counter.
    const { error } = await supabaseAdmin
      .from("ss4_applications")
      .update({
        view_count: (access.row.view_count || 0) + 1,
        viewed_at: new Date().toISOString(),
      })
      .eq("id", access.row.id)
    if (error) return NextResponse.json({ error: "Failed to record view" }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (body.action === "sign") {
    // Only a form actually out for signature may be signed — the exact same
    // gate the page enforced client-side (canSign = status === "awaiting_signature"),
    // now enforced server-side where it can't be skipped by calling this route directly.
    if (access.row.status !== "awaiting_signature") {
      return NextResponse.json({ error: "Not awaiting signature" }, { status: 409 })
    }
    if (!body.signature_data_url || typeof body.signature_data_url !== "string") {
      return NextResponse.json({ error: "signature_data_url required" }, { status: 400 })
    }
    const signedAt = new Date().toISOString()
    const { error } = await supabaseAdmin
      .from("ss4_applications")
      .update({
        status: "signed",
        signed_at: signedAt,
        signature_data: {
          dataUrl: body.signature_data_url,
          signedName: body.signed_name ?? null,
          signedAt,
        },
      })
      .eq("id", access.row.id)
    if (error) return NextResponse.json({ error: "Failed to record signature" }, { status: 500 })
    return NextResponse.json({ ok: true, signedAt })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
