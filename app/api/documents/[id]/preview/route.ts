/**
 * Document Preview API
 * Streams a file from Google Drive via service account.
 * No Google login required — the SA has access to the Shared Drive.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { downloadFileBinary } from "@/lib/google-drive"

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params

  // Look up document in Supabase
  const { data: doc, error } = await supabaseAdmin
    .from("documents")
    .select("drive_file_id, file_name, mime_type")
    .eq("id", id)
    .single()

  if (error || !doc?.drive_file_id) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 })
  }

  try {
    const { buffer, mimeType } = await downloadFileBinary(doc.drive_file_id)

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mimeType || "application/pdf",
        "Content-Disposition": `inline; filename="${doc.file_name || "document"}"`,
        "Cache-Control": "private, max-age=300",
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Download failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
