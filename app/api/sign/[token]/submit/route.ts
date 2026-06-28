/**
 * POST /api/sign/[token]/submit
 *
 * Signer-side submit. Validates the access code server-side, stores the signer's
 * drawn marks + field values, marks the signer `signed` (TOCTOU-guarded so a
 * double-submit can't double-count), writes the legal audit events with
 * SERVER-captured IP/UA + a signature hash, and atomically advances the
 * completion counter. When the last required signer signs, the server flattens
 * the signed PDF once.
 *
 * Body: {
 *   code: string, preview?: 'td',
 *   signature_png?: dataURL, initials_png?: dataURL,
 *   signed_by_name?: string, consent?: boolean, consent_text?: string,
 *   fields?: [{ field_id: string, value: string|null }]
 * }
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { flattenEnvelopeToSignedPdf, finalizeEsignCompletion } from "@/lib/operations/esign"
import { clientIp, userAgent } from "@/lib/esign/request-meta"
import { chooseLinkBase, originFromHeaders } from "@/lib/esign/link-base"
import { dispatchSignerDelivery } from "@/lib/esign/dispatch-delivery"
import { accessCodeError } from "@/lib/esign/access-guard"
import { isTerminalEnvelopeStatus } from "@/lib/esign/envelope-status"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const SIGNED_BUCKET = "signed-documents"

function dataUrlToBuffer(d: string): Buffer {
  const b64 = d.includes(",") ? d.split(",")[1] : d
  return Buffer.from(b64, "base64")
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const code = typeof body.code === "string" ? body.code : ""
  const isPreview = body.preview === "td"

  const { data: signer } = await db
    .from("esign_signers")
    .select("id, envelope_id, access_code, status, signing_order")
    .eq("token", token)
    .maybeSingle()
  if (!signer) return NextResponse.json({ error: "Signing link not found." }, { status: 404 })
  const codeErr = accessCodeError(req, { token, expected: signer.access_code, provided: code, isPreview })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })
  if (signer.status === "signed") {
    return NextResponse.json({ error: "This document has already been signed." }, { status: 409 })
  }

  const { data: env } = await db
    .from("esign_envelopes")
    .select("id, token, status, total_signers, routing_order")
    .eq("id", signer.envelope_id)
    .single()
  if (!env) return NextResponse.json({ error: "Document not found." }, { status: 404 })
  if (isTerminalEnvelopeStatus(env.status)) {
    return NextResponse.json({ error: `This document is ${env.status} and can no longer be signed.` }, { status: 410 })
  }

  // Sequential routing: enforce turn order. Every signer's link exists from
  // creation, so without this a signer holding their link could sign BEFORE it
  // is their turn, defeating sequential routing. Block until every earlier signer
  // (lower signing_order) has signed.
  if (env.routing_order === "sequential" && signer.signing_order != null && !isPreview) {
    const { data: earlier } = await db
      .from("esign_signers")
      .select("id")
      .eq("envelope_id", env.id)
      .lt("signing_order", signer.signing_order)
      .neq("status", "signed")
      .limit(1)
    if ((earlier ?? []).length > 0) {
      return NextResponse.json({ error: "It's not your turn to sign yet — an earlier signer must sign first." }, { status: 403 })
    }
  }

  // Required-field enforcement: every required field assigned to THIS signer must
  // be satisfied, or the flattened PDF would contain blank required boxes (a
  // signature field with no signature still "completed" the document). Checkboxes
  // are not enforced (a required checkbox left unticked is a deliberate choice).
  const fieldVals = Array.isArray(body.fields) ? body.fields : []
  if (!isPreview) {
    const valByField = new Map<string, string | null>()
    for (const fv of fieldVals) if (fv && typeof fv.field_id === "string") valByField.set(fv.field_id, fv.value ?? null)
    const hasSig = typeof body.signature_png === "string" && body.signature_png.length > 0
    const hasInitials = typeof body.initials_png === "string" && body.initials_png.length > 0
    const { data: reqFields } = await db
      .from("esign_fields")
      .select("id, field_type, required")
      .eq("envelope_id", signer.envelope_id)
      .eq("signer_id", signer.id)
    const unmet = (reqFields ?? []).some((f: { id: string; field_type: string; required: boolean }) => {
      if (!f.required) return false
      if (f.field_type === "signature") return !hasSig
      if (f.field_type === "initials") return !hasInitials
      if (f.field_type === "date" || f.field_type === "text") {
        const v = valByField.get(f.id)
        return !(typeof v === "string" && v.trim().length > 0)
      }
      return false
    })
    if (unmet) {
      return NextResponse.json({ error: "Please complete all required fields before submitting." }, { status: 400 })
    }
  }

  const ip = clientIp(req)
  const ua = userAgent(req)

  // Store drawn marks (best-effort upsert keyed by signer).
  let signaturePath: string | null = null
  let initialsPath: string | null = null
  if (typeof body.signature_png === "string" && body.signature_png) {
    signaturePath = `esign/${env.token}/sig-${signer.id}.png`
    const { error } = await supabaseAdmin.storage
      .from(SIGNED_BUCKET)
      .upload(signaturePath, dataUrlToBuffer(body.signature_png), { contentType: "image/png", upsert: true })
    if (error) return NextResponse.json({ error: "Could not save your signature. Please try again." }, { status: 500 })
  }
  if (typeof body.initials_png === "string" && body.initials_png) {
    initialsPath = `esign/${env.token}/initials-${signer.id}.png`
    await supabaseAdmin.storage
      .from(SIGNED_BUCKET)
      .upload(initialsPath, dataUrlToBuffer(body.initials_png), { contentType: "image/png", upsert: true })
  }

  // Field values — scoped to this signer's fields only.
  for (const fv of fieldVals) {
    if (!fv || typeof fv.field_id !== "string") continue
    await db
      .from("esign_fields")
      .update({ value: fv.value ?? null, filled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", fv.field_id)
      .eq("signer_id", signer.id)
      .eq("envelope_id", signer.envelope_id)
  }

  // Mark this signer's signature/initials fields filled (audit completeness — the
  // drawn marks aren't sent in `fields`; they flatten from the signer's images).
  const filledNow = new Date().toISOString()
  if (signaturePath) {
    await db.from("esign_fields").update({ filled_at: filledNow, updated_at: filledNow })
      .eq("envelope_id", signer.envelope_id).eq("signer_id", signer.id).eq("field_type", "signature")
  }
  if (initialsPath) {
    await db.from("esign_fields").update({ filled_at: filledNow, updated_at: filledNow })
      .eq("envelope_id", signer.envelope_id).eq("signer_id", signer.id).eq("field_type", "initials")
  }

  // Mark signer signed — TOCTOU guard: only if not already signed.
  const now = new Date().toISOString()
  const signedByName = typeof body.signed_by_name === "string" ? body.signed_by_name.trim() : null
  const consent = body.consent === true
  const consentText = typeof body.consent_text === "string" ? body.consent_text : null
  const { data: updated } = await db
    .from("esign_signers")
    .update({
      status: "signed",
      signed_at: now,
      consent_acknowledged: consent,
      consent_text: consentText,
      signed_by_name: signedByName,
      signature_image_path: signaturePath,
      initials_image_path: initialsPath,
      last_ip: ip,
      last_user_agent: ua,
      updated_at: now,
    })
    .eq("id", signer.id)
    .neq("status", "signed")
    .select("id")
    .maybeSingle()
  if (!updated) {
    // Lost the race to a concurrent submit — already counted.
    return NextResponse.json({ error: "This document has already been signed." }, { status: 409 })
  }

  const hash = createHash("sha256")
    .update(`${body.signature_png || ""}|${token}|${env.id}|${now}`)
    .digest("hex")
  await db.from("esign_events").insert([
    { envelope_id: env.id, signer_id: signer.id, event_type: "signed", ip, user_agent: ua, metadata: { signature_hash: hash, signed_by_name: signedByName } },
    { envelope_id: env.id, signer_id: signer.id, event_type: "consent_accepted", ip, user_agent: ua, metadata: { consent } },
  ])

  // Atomic completion gate.
  const { data: countData } = await db.rpc("increment_esign_signed_count", { envelope_uuid: env.id })
  const newCount = typeof countData === "number" ? countData : Number(countData)
  const totalSigners = env.total_signers ?? 1

  let completed = false
  if (Number.isFinite(newCount) && newCount >= totalSigners) {
    const { signedPath } = await flattenEnvelopeToSignedPdf(env.id)
    // Guarded completion claim (WHERE status <> 'completed') so completion can
    // run at most once even if some other path (the reconciliation cron, a retry)
    // also reaches the threshold — prevents a double "completed" event + double
    // filing into the client's documents.
    const { data: claimed } = await db
      .from("esign_envelopes")
      .update({ signed_pdf_path: signedPath, status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", env.id)
      .neq("status", "completed")
      .select("id")
      .maybeSingle()
    completed = true
    if (claimed) {
      await db.from("esign_events").insert({ envelope_id: env.id, event_type: "completed", metadata: { signed_pdf_path: signedPath } })
      // Post-completion side-effects: file the signed PDF into the client's
      // documents + notify support. Best-effort (never throws), so it can't break
      // the signer's response.
      await finalizeEsignCompletion(env.id)
    }
  } else {
    await db.from("esign_envelopes").update({ status: "in_progress", updated_at: new Date().toISOString() }).eq("id", env.id)
    // Sequential routing: hand off to the next pending signer through the same
    // channel dispatcher used by the initial send (portal client → portal +
    // nudge; third party / no-portal → email the link). Parallel signers were
    // all dispatched up front. Pick the lowest signing_order still pending.
    if (env.routing_order === "sequential") {
      const { data: next } = await db
        .from("esign_signers")
        .select("id")
        .eq("envelope_id", env.id)
        .eq("status", "pending")
        .order("signing_order", { ascending: true })
        .limit(1)
        .maybeSingle()
      if (next?.id) {
        const base = chooseLinkBase(originFromHeaders(n => req.headers.get(n)), process.env.VERCEL_ENV === "production")
        await dispatchSignerDelivery({ signerId: next.id, baseUrl: base })
      }
    }
  }

  return NextResponse.json({ ok: true, completed })
}
