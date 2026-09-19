/**
 * Document Preview API
 * Streams a document's file inline. Handles BOTH storage shapes:
 *   - Google Drive (real `drive_file_id`) via the service account, and
 *   - Supabase Storage (synthetic `storage:<path>` id in `onboarding-uploads`)
 *     used by flow uploads and persisted fax-upload attachments.
 * Dashboard users only — every real caller (fax history, contact document
 * preview, SS-4 fax panel, flow document fallback link) is a staff-only CRM
 * surface. This route used to have NO access check beyond "some session
 * exists", which a logged-in CLIENT portal session also satisfies — a client
 * who obtained any document's id (passport, tax return, etc.) could pull its
 * bytes regardless of portal_visible or account ownership. Same class of gap
 * already closed on /api/storage/upload (2026-07-20) and matches the sibling
 * /api/drive-preview/[fileId] route's isDashboardUser gate.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { downloadFileBinary } from "@/lib/google-drive"

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

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
    let bytes: Buffer
    let mimeType: string | null = (doc.mime_type as string | null) ?? null

    if ((doc.drive_file_id as string).startsWith("storage:")) {
      // Supabase Storage shape: `storage:<path-within-onboarding-uploads>`.
      const path = (doc.drive_file_id as string).slice("storage:".length)
      const { data, error: dlErr } = await supabaseAdmin.storage
        .from("onboarding-uploads")
        .download(path)
      if (dlErr || !data) {
        return NextResponse.json({ error: "Document file not found" }, { status: 404 })
      }
      bytes = Buffer.from(await data.arrayBuffer())
      mimeType = mimeType || data.type || "application/pdf"
    } else {
      const drive = await downloadFileBinary(doc.drive_file_id as string)
      bytes = drive.buffer
      mimeType = mimeType || drive.mimeType
    }

    return new NextResponse(new Uint8Array(bytes), {
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
