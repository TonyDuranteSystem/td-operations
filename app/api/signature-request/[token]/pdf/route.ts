import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { downloadFileBinary } from "@/lib/google-drive"

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const { token } = params

  const { data: sigReq, error } = await supabaseAdmin
    .from("signature_requests")
    .select("pdf_storage_path, drive_file_id, status")
    .eq("token", token)
    .single()

  if (error || !sigReq) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  let buffer: Buffer

  // Prefer Drive if drive_file_id is set, fall back to Supabase Storage
  if (sigReq.drive_file_id) {
    try {
      const result = await downloadFileBinary(sigReq.drive_file_id)
      buffer = result.buffer
    } catch (driveErr) {
      console.error("[signature-pdf] Drive download failed:", driveErr)
      return NextResponse.json({ error: "PDF not found on Drive" }, { status: 404 })
    }
  } else {
    const { data: fileData, error: dlError } = await supabaseAdmin.storage
      .from("signature-requests")
      .download(sigReq.pdf_storage_path)

    if (dlError || !fileData) {
      return NextResponse.json({ error: "PDF not found in storage" }, { status: 404 })
    }

    buffer = Buffer.from(await fileData.arrayBuffer())
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${token}.pdf"`,
      "Cache-Control": "private, max-age=3600",
    },
  })
}
