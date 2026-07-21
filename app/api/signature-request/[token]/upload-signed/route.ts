import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"

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

    const { data: sigReq, error: sigErr } = await supabaseAdmin
      .from("signature_requests")
      .select("id, token, access_code, document_name")
      .eq("token", token)
      .maybeSingle()

    if (sigErr || !sigReq) {
      return NextResponse.json({ error: "Signature request not found" }, { status: 404 })
    }

    // Admin preview requires a REAL staff session — the flag alone proves
    // nothing, and this upload overwrites a signed document.
    // See lib/auth/staff-preview.ts (2026-07-21 incident).
    const isAdmin = await isStaffPreview(preview === "td")
    if (!isAdmin && sigReq.access_code !== code) {
      return NextResponse.json({ error: "Invalid access code" }, { status: 403 })
    }

    const storagePath = `${token}/signed-${Date.now()}.pdf`
    const arrayBuffer = await pdfFile.arrayBuffer()

    const { error: uploadErr } = await supabaseAdmin.storage
      .from("signed-documents")
      .upload(storagePath, Buffer.from(arrayBuffer), {
        contentType: "application/pdf",
        upsert: true,
      })

    if (uploadErr) {
      console.error("[signature-upload] Storage error:", uploadErr)
      return NextResponse.json({ error: "Storage upload failed" }, { status: 500 })
    }

    return NextResponse.json({ ok: true, path: storagePath })
  } catch (err) {
    console.error("[signature-upload]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
