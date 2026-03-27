/**
 * GET /api/8832/[token]/pdf
 *
 * Generates and returns the pre-filled Form 8832 PDF for a given application.
 * Used by the signing page to display the form.
 * Requires ?code= query param matching the access_code for authorization.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { fill8832, type Form8832FillData } from "@/lib/pdf/8832-fill"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const code = request.nextUrl.searchParams.get("code")
  const isAdmin = request.nextUrl.searchParams.get("preview") === "td"

  const { data: form, error } = await supabaseAdmin
    .from("form_8832_applications")
    .select("*")
    .eq("token", token)
    .maybeSingle()

  if (error || !form) {
    return NextResponse.json({ error: "Form 8832 application not found" }, { status: 404 })
  }

  if (!isAdmin && form.access_code !== code) {
    return NextResponse.json({ error: "Invalid access code" }, { status: 403 })
  }

  const fillData: Form8832FillData = {
    companyName: form.company_name,
    ein: form.ein,
    entityType: form.entity_type as Form8832FillData["entityType"],
    memberCount: form.member_count,
    ownerName: form.owner_name,
    ownerIdNumber: form.owner_id_number || undefined,
    effectiveDate: form.effective_date || "",
    ownerTitle: form.owner_title,
  }

  const pdfBytes = await fill8832(fillData)

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Form-8832-${form.company_name.replace(/[^a-zA-Z0-9]/g, "-")}.pdf"`,
      "Cache-Control": "private, max-age=300",
    },
  })
}
