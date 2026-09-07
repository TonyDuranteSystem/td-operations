import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { capturesTable } from "@/lib/captures/db"
import { WORKER_UPLOAD_BUCKET } from "@/lib/captures/storage"
import { NextRequest, NextResponse } from "next/server"

/**
 * GET /api/captures/[id]/image
 *
 * Streams a capture's bytes from the private worker-attachments bucket.
 * Deliberately a server-side proxy, not a signed URL handed to the client:
 * this keeps the OWNER check (below) enforced on every single view, matching
 * the folder's own rule (Antonio: "only mine") rather than trusting a URL
 * that, once minted, would work for anyone who got hold of it until it
 * expired. Never cached at a shared/CDN layer — private, per-viewer content.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const { data: capture, error: captureErr } = await capturesTable()
    .select("id, image_url, mime_type, captured_by_user_id")
    .eq("id", params.id)
    .single()
  if (captureErr || !capture) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (capture.captured_by_user_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).download(capture.image_url)
  if (dlErr || !blob) return NextResponse.json({ error: "Could not load the picture." }, { status: 500 })

  return new NextResponse(blob, {
    headers: {
      "Content-Type": capture.mime_type || "image/png",
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  })
}
