/**
 * GET /api/ss4/[token]/pdf
 *
 * Generates and returns the pre-filled SS-4 PDF for a given application.
 * Used by the signing page to display the form.
 * Requires ?code= query param matching the access_code for authorization.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { accessCodeError } from "@/lib/esign/access-guard"
import { fillSS4 } from "@/lib/pdf/ss4-fill"
import { ss4FillDataFromRow, type Ss4Row } from "@/lib/operations/ss4-store"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const code = request.nextUrl.searchParams.get("code")
  // Admin preview requires a REAL staff session — the flag alone proves nothing.
  // See lib/auth/staff-preview.ts (2026-07-21 incident).
  const isAdmin = await isStaffPreview(request.nextUrl.searchParams.get("preview") === "td")

  // Fetch the SS-4 application
  const { data: ss4, error } = await supabaseAdmin
    .from("ss4_applications")
    .select("*")
    .eq("token", token)
    .maybeSingle()

  if (error || !ss4) {
    return NextResponse.json({ error: "SS-4 application not found" }, { status: 404 })
  }

  // Verify access code — fails closed on a blank/null code (a bare !== compare
  // treats null-equals-null as a match, an exposure this exact table already
  // hit once via schema drift, see lib/operations/ss4.ts), constant-time, and
  // rate-limited so the 32-bit access_code can't be brute-forced. Returns the
  // FILLED PDF including responsible_party_itin, so this is the only real
  // gate on that data now that ss4_applications' anon database access is
  // revoked (dev job 527b2377).
  const codeErr = accessCodeError(request, { token, expected: ss4.access_code ?? "", provided: code ?? "", isPreview: isAdmin })
  if (codeErr) {
    return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })
  }

  // Build fill data from the DB record (shared with the stored copy — lib/operations/ss4-store.ts)
  const fillData = ss4FillDataFromRow(ss4 as unknown as Ss4Row)

  // Generate the filled PDF
  const pdfBytes = await fillSS4(fillData)

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Form-SS4-${ss4.company_name.replace(/[^a-zA-Z0-9]/g, "-")}.pdf"`,
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
