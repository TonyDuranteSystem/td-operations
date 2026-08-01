/**
 * GET /api/lease/[token]/signed-pdf?code=<accessCode>[&preview=td]
 *
 * Returns { url } — a short-lived signed URL to the client's OWN signed lease PDF.
 * Token-gated, NOT session-gated (under the already-public /api/lease/ prefix).
 * Verifies the lease access code SERVER-SIDE with the same constant-time,
 * rate-limited guard the lease fetch route uses, then signs the DB-RECORDED path
 * (`lease_agreements.pdf_storage_path`) — never a folder listing. This REPLACES the
 * lease page's old anon `list()` + `download(newest)` fallback so the signed-leases
 * bucket no longer needs to be anon-readable.
 *
 * Fails CLOSED: 404 when the lease/PDF is absent, and the access-code guard's own
 * 403/429 for a bad or missing code. Staff preview (a REAL staff session, never the
 * bare query flag) skips the code exactly as the fetch route does.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { createRecordedSignedUrl } from "@/lib/storage/signed-download"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  const { data: lease } = await db
    .from("lease_agreements")
    .select("id, access_code, pdf_storage_path")
    .eq("token", token)
    .maybeSingle()

  if (!lease) {
    return NextResponse.json({ error: "Lease not found." }, { status: 404 })
  }

  // Access-code gate — constant-time, rate-limited, fail-closed on a blank code.
  const codeErr = accessCodeError(req, { token, expected: lease.access_code, provided: code, isPreview })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  const signedUrl = await createRecordedSignedUrl("signed-leases", lease.pdf_storage_path, 60)
  if (!signedUrl) {
    return NextResponse.json({ error: "Signed lease not available." }, { status: 404 })
  }

  return NextResponse.json({ url: signedUrl })
}
