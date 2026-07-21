/**
 * GET /api/sign/[token]/pdf?code=<accessCode>[&preview=td]
 *
 * Streams the SOURCE PDF for a signer to view. Access-code validated server-side
 * against the signer's per-signer token. Served from storage (uniform sandbox/prod).
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { isStaffPreview } from "@/lib/auth/staff-preview"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const SOURCE_BUCKET = "signature-requests"

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  // Admin preview requires a REAL staff session — the flag alone proves nothing.
  // See lib/auth/staff-preview.ts (2026-07-21 incident).
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  const { data: signer } = await db
    .from("esign_signers")
    .select("envelope_id, access_code")
    .eq("token", token)
    .maybeSingle()
  if (!signer) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const codeErr = accessCodeError(req, { token, expected: signer.access_code, provided: code, isPreview })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  const { data: env } = await db
    .from("esign_envelopes")
    .select("pdf_storage_path")
    .eq("id", signer.envelope_id)
    .single()
  if (!env?.pdf_storage_path) return NextResponse.json({ error: "PDF not found" }, { status: 404 })

  const { data, error } = await supabaseAdmin.storage.from(SOURCE_BUCKET).download(env.pdf_storage_path)
  if (error || !data) return NextResponse.json({ error: "PDF not found" }, { status: 404 })

  const bytes = new Uint8Array(await data.arrayBuffer())
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="document.pdf"',
      "Cache-Control": "private, no-store",
    },
  })
}
