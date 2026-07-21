/**
 * GET /api/sign/[token]/fetch?code=<accessCode>[&preview=td]
 *
 * Signer-side, no login. Resolves the signer by their per-signer token, validates
 * the access code SERVER-SIDE, and returns the envelope + ONLY this signer's
 * fields (never co-signers' data). Records a `viewed` event with server-captured
 * IP/UA on first non-preview view.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { clientIp, userAgent } from "@/lib/esign/request-meta"
import { accessCodeError } from "@/lib/esign/access-guard"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { isTerminalEnvelopeStatus } from "@/lib/esign/envelope-status"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  // Admin preview requires a REAL staff session — the flag alone proves nothing.
  // See lib/auth/staff-preview.ts (2026-07-21 incident).
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  const { data: signer } = await db
    .from("esign_signers")
    .select("id, envelope_id, signer_index, name, status, access_code, signed_at, view_count, signing_order")
    .eq("token", token)
    .maybeSingle()
  if (!signer) return NextResponse.json({ error: "Signing link not found." }, { status: 404 })
  const codeErr = accessCodeError(req, { token, expected: signer.access_code, provided: code, isPreview })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  const { data: env } = await db
    .from("esign_envelopes")
    .select("id, document_name, description, page_count, status, routing_order, signed_count, total_signers")
    .eq("id", signer.envelope_id)
    .single()
  if (!env) return NextResponse.json({ error: "Document not found." }, { status: 404 })
  if (env.status === "voided" || env.status === "expired") {
    return NextResponse.json({ error: `This document is ${env.status} and can no longer be signed.` }, { status: 410 })
  }

  const { data: fields } = await db
    .from("esign_fields")
    .select("id, field_type, page_index, pos_x, pos_y, width, height, required, placeholder, value, font_size")
    .eq("envelope_id", signer.envelope_id)
    .eq("signer_id", signer.id)

  if (!isPreview && signer.status !== "signed" && !isTerminalEnvelopeStatus(env.status)) {
    const now = new Date().toISOString()
    await db
      .from("esign_signers")
      .update({
        status: signer.status === "pending" || signer.status === "sent" ? "viewed" : signer.status,
        viewed_at: now,
        view_count: (signer.view_count ?? 0) + 1,
        last_ip: clientIp(req),
        last_user_agent: userAgent(req),
        updated_at: now,
      })
      .eq("id", signer.id)
    await db.from("esign_events").insert({
      envelope_id: signer.envelope_id,
      signer_id: signer.id,
      event_type: "viewed",
      ip: clientIp(req),
      user_agent: userAgent(req),
    })
  }

  return NextResponse.json({
    envelope: {
      document_name: env.document_name,
      description: env.description,
      page_count: env.page_count,
      status: env.status,
    },
    signer: { name: signer.name, status: signer.status, alreadySigned: signer.status === "signed" },
    fields: fields ?? [],
    pdfUrl: `/api/sign/${token}/pdf?code=${encodeURIComponent(code)}${isPreview ? "&preview=td" : ""}`,
  })
}
