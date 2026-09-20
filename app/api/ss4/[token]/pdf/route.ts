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
import { fillSS4, type SS4FillData } from "@/lib/pdf/ss4-fill"
import { CLIENT_ADDRESS_FALLBACK } from "@/lib/td-address"

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

  // Mailing address — fall back to TD Park Blvd for legacy rows without stored address
  const TD_FALLBACK_STREET = CLIENT_ADDRESS_FALLBACK.street
  const TD_FALLBACK_CITY_STATE_ZIP = CLIENT_ADDRESS_FALLBACK.cityStateZip
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ss4Any = ss4 as any
  const mailingStreet: string = ss4Any.mailing_street || TD_FALLBACK_STREET
  const mailingCityStateZip: string = ss4Any.mailing_city_state_zip || TD_FALLBACK_CITY_STATE_ZIP

  // Build fill data from the DB record
  const fillData: SS4FillData = {
    companyName: ss4.company_name,
    tradeName: ss4.trade_name || undefined,
    entityType: ss4.entity_type as SS4FillData["entityType"],
    stateOfFormation: ss4.state_of_formation,
    formationDate: ss4.formation_date || "",
    memberCount: ss4.member_count,
    responsiblePartyName: ss4.responsible_party_name,
    responsiblePartyItin: ss4.responsible_party_itin || undefined,
    responsiblePartyPhone: ss4.responsible_party_phone || undefined,
    responsiblePartyTitle: ss4.responsible_party_title,
    mailingStreet,
    mailingCityStateZip,
    countyAndState: ss4.county_and_state || undefined,
  }

  // Generate the filled PDF
  const pdfBytes = await fillSS4(fillData)

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Form-SS4-${ss4.company_name.replace(/[^a-zA-Z0-9]/g, "-")}.pdf"`,
      "Cache-Control": "private, max-age=300",
    },
  })
}
