/**
 * POST /api/ss4/[token]/upload-signed
 *
 * Receives the signed SS-4 PDF from the client and uploads it to
 * Supabase Storage using service_role (bypasses storage RLS).
 *
 * Body: FormData with "pdf" file and "code" access code
 * Returns: { ok: true, path: string }
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { accessCodeError } from "@/lib/esign/access-guard"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params

    const formData = await req.formData()
    const pdfFile = formData.get("pdf") as File | null
    const code = formData.get("code") as string | null
    const preview = formData.get("preview") as string | null

    if (!pdfFile) {
      return NextResponse.json({ error: "pdf file required" }, { status: 400 })
    }

    // Verify the SS-4 exists and access is valid
    const { data: ss4, error: ss4Err } = await supabaseAdmin
      .from("ss4_applications")
      .select("id, token, access_code, company_name")
      .eq("token", token)
      .maybeSingle()

    if (ss4Err || !ss4) {
      return NextResponse.json({ error: "SS-4 not found" }, { status: 404 })
    }

    // Verify access code. Admin preview requires a REAL staff session — the
    // flag alone proves nothing. This upload overwrites the stored signed SS-4
    // (upsert:true below), so a bypass here is document substitution on an IRS
    // filing. See lib/auth/staff-preview.ts (2026-07-21 incident). Fails
    // closed on a blank/null code and is rate-limited — see the pdf route's
    // matching comment; this table's anon database access is revoked as of
    // dev job 527b2377, making this the only real gate on this write.
    const isAdmin = await isStaffPreview(preview === "td")
    const codeErr = accessCodeError(req, { token, expected: ss4.access_code ?? "", provided: code ?? "", isPreview: isAdmin })
    if (codeErr) {
      return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })
    }

    // Upload to Supabase Storage using service_role
    const companySlug = ss4.company_name.replace(/[^a-zA-Z0-9]/g, "-")
    const storagePath = `${token}/Form-SS4-${companySlug}-Signed.pdf`

    const arrayBuffer = await pdfFile.arrayBuffer()
    const { error: uploadErr } = await supabaseAdmin.storage
      .from("signed-ss4")
      .upload(storagePath, Buffer.from(arrayBuffer), {
        contentType: "application/pdf",
        upsert: true,
      })

    if (uploadErr) {
      console.error("[upload-signed] Storage error:", uploadErr)
      return NextResponse.json({ error: "Storage upload failed" }, { status: 500 })
    }

    return NextResponse.json({ ok: true, path: storagePath })
  } catch (err) {
    console.error("[upload-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
