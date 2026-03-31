import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const { token } = params

  const { data: sigReq, error } = await supabaseAdmin
    .from("signature_requests")
    .select("pdf_storage_path, status")
    .eq("token", token)
    .single()

  if (error || !sigReq) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const { data: fileData, error: dlError } = await supabaseAdmin.storage
    .from("signature-requests")
    .download(sigReq.pdf_storage_path)

  if (dlError || !fileData) {
    return NextResponse.json({ error: "PDF not found in storage" }, { status: 404 })
  }

  const buffer = Buffer.from(await fileData.arrayBuffer())
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${token}.pdf"`,
      "Cache-Control": "private, max-age=3600",
    },
  })
}
