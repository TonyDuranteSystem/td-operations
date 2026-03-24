/**
 * GET /api/ss4/[token]/pdf
 *
 * Generates the pre-filled SS-4 PDF with Articles of Organization attached.
 * The combined PDF is what gets presented for signing and faxed to the IRS.
 *
 * Output: Page 1 = filled SS-4, Page 2+ = Articles of Organization
 * Requires ?code= query param or ?preview=td for admin access.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { fillSS4, type SS4FillData } from "@/lib/pdf/ss4-fill"
import { PDFDocument } from "pdf-lib"

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

  // Generate the filled SS-4 (2 pages: form + instructions)
  const ss4Bytes = await fillSS4(fillData)

  // Build the final PDF: SS-4 page 1 only + Articles of Organization
  const finalPdf = await PDFDocument.create()

  // Copy only page 1 of the SS-4 (skip page 2 "Do I Need an EIN?")
  const ss4Doc = await PDFDocument.load(ss4Bytes)
  const [ss4Page1] = await finalPdf.copyPages(ss4Doc, [0])
  finalPdf.addPage(ss4Page1)

  // Find and attach Articles of Organization from client's Drive folder
  if (ss4.account_id) {
    try {
      const { data: acct } = await supabaseAdmin
        .from("accounts")
        .select("drive_folder_id")
        .eq("id", ss4.account_id)
        .single()

      if (acct?.drive_folder_id) {
        const { listFolder, downloadFileBinary } = await import("@/lib/google-drive")

        // Find "1. Company" subfolder
        const rootFiles = await listFolder(acct.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
        const companyFolder = rootFiles.files?.find(f =>
          f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder"
        )

        if (companyFolder?.id) {
          const companyFiles = await listFolder(companyFolder.id) as { files?: { id: string; name: string; mimeType: string }[] }
          const articlesFile = companyFiles.files?.find(f =>
            /articles/i.test(f.name) && f.mimeType === "application/pdf"
          )

          if (articlesFile?.id) {
            const { buffer: articlesBuffer } = await downloadFileBinary(articlesFile.id)
            const articlesDoc = await PDFDocument.load(articlesBuffer)
            const articlesPages = await finalPdf.copyPages(articlesDoc, articlesDoc.getPageIndices())
            articlesPages.forEach(p => finalPdf.addPage(p))
          }
        }
      }
    } catch {
      // Articles not found — continue with SS-4 only
    }
  }

  const finalBytes = await finalPdf.save()

  return new NextResponse(Buffer.from(finalBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Form-SS4-${ss4.company_name.replace(/[^a-zA-Z0-9]/g, "-")}.pdf"`,
      "Cache-Control": "private, max-age=60",
    },
  })
}
