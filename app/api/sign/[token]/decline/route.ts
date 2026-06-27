/**
 * POST /api/sign/[token]/decline — a signer declines to sign (with an optional
 * reason). One decline voids the whole envelope (status → declined). Server-side
 * access-code validation + audit event + best-effort support notification.
 *
 * Body: { code: string, preview?: 'td', reason?: string }
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { clientIp, userAgent } from "@/lib/esign/request-meta"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const code = typeof body.code === "string" ? body.code : ""
  const isPreview = body.preview === "td"
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : ""

  const { data: signer } = await db
    .from("esign_signers")
    .select("id, envelope_id, access_code, status")
    .eq("token", token)
    .maybeSingle()
  if (!signer) return NextResponse.json({ error: "Signing link not found." }, { status: 404 })
  if (!isPreview && signer.access_code !== code) return NextResponse.json({ error: "Invalid access code." }, { status: 403 })
  if (signer.status === "signed") return NextResponse.json({ error: "You have already signed this document." }, { status: 409 })
  if (signer.status === "declined") return NextResponse.json({ ok: true, declined: true })

  const { data: env } = await db.from("esign_envelopes").select("id, status").eq("id", signer.envelope_id).single()
  if (!env) return NextResponse.json({ error: "Document not found." }, { status: 404 })
  if (env.status === "voided" || env.status === "expired" || env.status === "completed") {
    return NextResponse.json({ error: `This document is ${env.status}.` }, { status: 410 })
  }

  const ip = clientIp(req)
  const ua = userAgent(req)
  const now = new Date().toISOString()

  await db
    .from("esign_signers")
    .update({ status: "declined", declined_at: now, decline_reason: reason || null, last_ip: ip, last_user_agent: ua, updated_at: now })
    .eq("id", signer.id)
    .neq("status", "declined")
  await db.from("esign_envelopes").update({ status: "declined", updated_at: now }).eq("id", env.id)
  await db.from("esign_events").insert({ envelope_id: env.id, signer_id: signer.id, event_type: "declined", ip, user_agent: ua, metadata: { reason } })

  // Best-effort support notification (no-op in sandbox).
  try {
    const { data: full } = await db.from("esign_envelopes").select("document_name, owner_account_id").eq("id", env.id).maybeSingle()
    let company = ""
    if (full?.owner_account_id) {
      const { data: acct } = await db.from("accounts").select("company_name").eq("id", full.owner_account_id).maybeSingle()
      company = acct?.company_name || ""
    }
    const { gmailPost } = await import("@/lib/gmail")
    const subject = `E-Sign DECLINED: ${full?.document_name || "document"}${company ? ` — ${company}` : ""}`
    const encoded = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const raw = [
      `From: support@tonydurante.us`,
      `To: support@tonydurante.us`,
      `Subject: ${encoded}`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      `A signer declined "${full?.document_name || "document"}".`,
      reason ? `Reason: ${reason}` : `No reason given.`,
    ].join("\r\n")
    await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ ok: true, declined: true })
}
