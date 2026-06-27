/**
 * GET /api/esign/envelopes/[id]/document?type=source|signed
 *
 * Staff-only. Streams the envelope's source PDF, or the completed signed PDF
 * (which includes the Certificate of Completion), as a download.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const SOURCE_BUCKET = "signature-requests"
const SIGNED_BUCKET = "signed-documents"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const { id } = await params
  const type = new URL(req.url).searchParams.get("type") === "signed" ? "signed" : "source"

  const { data: env } = await db
    .from("esign_envelopes")
    .select("document_name, pdf_storage_path, signed_pdf_path")
    .eq("id", id)
    .maybeSingle()
  if (!env) return NextResponse.json({ error: "Envelope not found" }, { status: 404 })

  const bucket = type === "signed" ? SIGNED_BUCKET : SOURCE_BUCKET
  const path = type === "signed" ? env.signed_pdf_path : env.pdf_storage_path
  if (!path) {
    return NextResponse.json(
      { error: type === "signed" ? "This envelope hasn't been signed yet." : "No source document on file." },
      { status: 404 },
    )
  }

  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path)
  if (error || !data) return NextResponse.json({ error: "File not found in storage." }, { status: 404 })

  const bytes = new Uint8Array(await data.arrayBuffer())
  const safeName = (env.document_name || "document").replace(/[^a-zA-Z0-9._-]/g, "_")
  const fileName = `${safeName}${type === "signed" ? "-signed" : ""}.pdf`
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
