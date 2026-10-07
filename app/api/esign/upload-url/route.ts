/**
 * POST /api/esign/upload-url — signed direct-to-Storage upload link for the PDF
 * on the E-Sign create screen (and the "save as template" action).
 *
 * Staff-only. Body: { file_size: number }  (a courtesy check — the real size is
 * read from storage when the file is claimed, see lib/esign/staging.ts).
 *
 * Why: Vercel rejects any request body over 4.5 MB before our code runs, so the
 * PDF must go browser → storage, not through this app. The path is minted HERE,
 * in its own `esign-staging/<userId>/` prefix of the private bucket — the client
 * never chooses it. `upsert: true` so a retried PUT (response lost, network
 * blip) overwrites its own half-finished object instead of failing "already
 * exists".
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { reportSystemError } from "@/lib/system-errors"
import { ESIGN_MAX_PDF_BYTES, ESIGN_STAGING_BUCKET, buildStagingPath, tooLargeMessage } from "@/lib/esign/staging"

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const fileSize = typeof body.file_size === "number" && Number.isFinite(body.file_size) ? body.file_size : 0
  if (fileSize <= 0) return NextResponse.json({ error: "The file is empty." }, { status: 400 })
  if (fileSize > ESIGN_MAX_PDF_BYTES) {
    return NextResponse.json({ error: tooLargeMessage(fileSize) }, { status: 400 })
  }

  const path = buildStagingPath(user.id, randomUUID())
  const { data, error } = await supabaseAdmin.storage
    .from(ESIGN_STAGING_BUCKET)
    .createSignedUploadUrl(path, { upsert: true })
  if (error || !data) {
    console.error("[esign-upload-url] signed-URL error:", error)
    await reportSystemError({
      source: "server",
      route: "esign/upload-url",
      method: "POST",
      http_status: 500,
      message: error?.message || "createSignedUploadUrl returned no data",
    })
    // No storage detail goes back to the browser.
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 500 })
  }

  // No public URL exists for this private object; the caller hands `path` back to the create route.
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
