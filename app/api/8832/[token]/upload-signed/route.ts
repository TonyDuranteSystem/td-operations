/**
 * POST /api/8832/[token]/upload-signed
 *
 * Receives the signed Form 8832 PDF and uploads to Supabase Storage.
 * Body: FormData with "pdf" file and "code" access code
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

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

    const { data: form, error: formErr } = await supabaseAdmin
      .from("form_8832_applications")
      .select("id, token, access_code, company_name")
      .eq("token", token)
      .maybeSingle()

    if (formErr || !form) {
      return NextResponse.json({ error: "Form 8832 not found" }, { status: 404 })
    }

    if (preview !== "td" && form.access_code !== code) {
      return NextResponse.json({ error: "Invalid access code" }, { status: 403 })
    }

    const companySlug = form.company_name.replace(/[^a-zA-Z0-9]/g, "-")
    const storagePath = `${token}/Form-8832-${companySlug}-Signed.pdf`

    const arrayBuffer = await pdfFile.arrayBuffer()
    const { error: uploadErr } = await supabaseAdmin.storage
      .from("signed-8832")
      .upload(storagePath, Buffer.from(arrayBuffer), {
        contentType: "application/pdf",
        upsert: true,
      })

    if (uploadErr) {
      console.error("[8832 upload-signed] Storage error:", uploadErr)
      return NextResponse.json({ error: "Storage upload failed" }, { status: 500 })
    }

    return NextResponse.json({ ok: true, path: storagePath })
  } catch (err) {
    console.error("[8832 upload-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
