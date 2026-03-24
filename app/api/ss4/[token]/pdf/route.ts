/**
 * GET /api/ss4/[token]/pdf
 *
 * Generates and returns the pre-filled SS-4 PDF for a given application.
 * Used by the signing page to display the form.
 * Requires ?code= query param matching the access_code for authorization.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { fillSS4, type SS4FillData } from "@/lib/pdf/ss4-fill"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const code = request.nextUrl.searchParams.get("code")
  const isAdmin = request.nextUrl.searchParams.get("preview") === "td"

  // Fetch the SS-4 application
  const { data: ss4, error } = await supabaseAdmin
    .from("ss4_applications")
    .select("*")
    .eq("token", token)
    .maybeSingle()

  if (error || !ss4) {
    return NextResponse.json({ error: "SS-4 application not found" }, { status: 404 })
  }

  // Verify access code (skip for admin preview)
  if (!isAdmin && ss4.access_code !== code) {
    return NextResponse.json({ error: "Invalid access code" }, { status: 403 })
  }

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
