/**
 * finalizeOaAgreement — render the executed Operating Agreement + legal certificate
 * and file it, then flip the agreement to "signed".
 *
 * Shared by two callers:
 *   1. the signing endpoint, on the last signature (the happy path);
 *   2. the reconciliation cron, for any agreement that collected all its signatures
 *      but did not finish finalizing (a render/store hiccup on the last signer).
 *
 * It is IDEMPOTENT and guarded:
 *   - refuses an agreement that is already signed / voided;
 *   - refuses a paper ("by_hand") agreement — those deliberately have no rendered
 *     PDF and must never be manufactured one;
 *   - refuses until every signer has signed (signed_count >= total_signers);
 *   - stores the executed PDF BEFORE flipping status, so a failure leaves the
 *     agreement "partially_signed" for the next run, never "signed with nothing filed".
 *
 * Filing to Drive + the formation side-effects stay owned by /api/oa-signed, which
 * this calls after the flip.
 */

import { createHash } from "crypto"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { normalizeEntityType } from "@/lib/portal/entity-type"
import { generateOperatingAgreementPDF, type OASignatureBlock } from "@/lib/pdf/operating-agreement-pdf"
import { appendCertificatePage, type CertificateSigner } from "@/lib/esign/certificate"
import { toPublicMembers } from "@/lib/oa/public-view"
import { reportSystemError } from "@/lib/system-errors"
import { internalWebhookServerHeaders } from "@/lib/webhook-internal-auth"
import type { OAData, OAMember } from "@/lib/types/oa-templates"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

// Server-side select — INCLUDES the audit columns the certificate needs. The public
// OA_SIGNATURE_SELECT deliberately omits these; reading with it would hand the
// Certificate of Completion blank IP / device / consent / hash.
const SIGNER_AUDIT_SELECT =
  "id, oa_id, member_index, member_name, member_email, status, signed_at, " +
  "signature_image_path, signed_by_name, last_ip, last_user_agent, consent, signature_hash, signature_method"

const SIGNATURE_BUCKET = "signed-oa"
const OA_CONSENT_TEXT =
  "I agree to sign this Operating Agreement electronically, and I agree that my " +
  "electronic signature is the legal equivalent of my handwritten signature."

export type FinalizeResult = {
  ok: boolean
  pdfPath?: string
  skipped?: "already_signed" | "by_hand" | "incomplete"
  error?: string
}

async function imageFor(path: string | null): Promise<Uint8Array | null> {
  if (!path) return null
  try {
    const { data: blob } = await supabaseAdmin.storage.from(SIGNATURE_BUCKET).download(path)
    if (!blob) return null
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null
  }
}

export async function finalizeOaAgreement(oaId: string): Promise<FinalizeResult> {
  const { data: agreement, error } = await db
    .from("oa_agreements")
    .select("*")
    .eq("id", oaId)
    .maybeSingle()
  if (error) return { ok: false, error: `load agreement: ${error.message}` }
  if (!agreement) return { ok: false, error: "agreement not found" }

  if (agreement.status === "signed") return { ok: true, skipped: "already_signed" }
  if (agreement.status === "voided") return { ok: true, skipped: "already_signed" }
  // Paper agreements deliberately have no rendered instrument — never fabricate one.
  if (agreement.signature_method === "by_hand") return { ok: true, skipped: "by_hand" }

  const isMMLLC =
    normalizeEntityType(agreement.entity_type) === "MMLLC" && (agreement.total_signers || 1) > 1
  const totalSigners = agreement.total_signers || 1

  const { data: freshRows } = await db
    .from("oa_signatures")
    .select(SIGNER_AUDIT_SELECT)
    .eq("oa_id", oaId)
    .order("member_index")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allRows: any[] = freshRows ?? []
  const signedRows = allRows.filter(r => r.status === "signed")
  if (signedRows.length < totalSigners) return { ok: true, skipped: "incomplete" }

  const now = new Date().toISOString()

  let signatureBlocks: OASignatureBlock[] = []
  let soleSignaturePng: Uint8Array | null = null
  let soleSignedAt: string | null = agreement.signed_at ?? null
  if (isMMLLC) {
    signatureBlocks = await Promise.all(
      allRows.map(async r => ({
        memberIndex: r.member_index,
        signedAt: r.status === "signed" ? r.signed_at : null,
        signaturePng: r.status === "signed" ? await imageFor(r.signature_image_path) : null,
      })),
    )
    // A signed member whose image did not load must NOT be baked into a "final"
    // agreement — that would file a legal doc showing them unsigned, and (status
    // being 'signed') nothing would retry. Fail so it stays partial and re-runs.
    const missing = signatureBlocks.find(
      (b, i) => allRows[i].status === "signed" && !b.signaturePng,
    )
    if (missing) return { ok: false, error: `signature image missing for member ${missing.memberIndex}` }
  } else {
    const sole = allRows.find(r => r.member_index === 0) ?? allRows[0]
    if (sole?.status === "signed") {
      soleSignedAt = sole.signed_at ?? soleSignedAt
      soleSignaturePng = await imageFor(sole.signature_image_path)
    }
    if (!soleSignaturePng) return { ok: false, error: "signature image missing for sole member" }
  }

  const members: OAMember[] = isMMLLC ? (toPublicMembers(agreement.members) ?? []) : []
  const data: OAData = {
    company_name: agreement.company_name,
    state_of_formation: agreement.state_of_formation,
    formation_date: agreement.formation_date,
    ein_number: agreement.ein_number ?? undefined,
    entity_type: isMMLLC ? "MMLLC" : "SMLLC",
    member_name: agreement.member_name,
    member_address: agreement.member_address ?? undefined,
    members: isMMLLC ? members : undefined,
    manager_name: agreement.manager_name || agreement.member_name,
    effective_date: agreement.effective_date,
    business_purpose: agreement.business_purpose,
    initial_contribution: agreement.initial_contribution,
    fiscal_year_end: agreement.fiscal_year_end,
    accounting_method: agreement.accounting_method,
    duration: agreement.duration,
    registered_agent_name: agreement.registered_agent_name ?? undefined,
    registered_agent_address: agreement.registered_agent_address ?? undefined,
    principal_address: agreement.principal_address,
  }

  let finalBytes: Uint8Array
  try {
    const renderedBytes = await generateOperatingAgreementPDF({
      data,
      signatures: signatureBlocks,
      soleSignaturePng,
      soleSignedAt,
    })
    const documentSha256 = createHash("sha256").update(Buffer.from(renderedBytes)).digest("hex")
    const certSigners: CertificateSigner[] = signedRows.map(r => ({
      name: r.member_name,
      email: r.member_email ?? null,
      signedByName: r.signed_by_name ?? r.member_name,
      signedAt: r.signed_at ?? null,
      ip: r.last_ip ?? null,
      userAgent: r.last_user_agent ?? null,
      consent: !!r.consent,
      signatureHash: r.signature_hash ?? null,
    }))
    const pdf = await PDFDocument.load(renderedBytes)
    await appendCertificatePage(pdf, {
      envelopeId: agreement.id,
      documentName: `Operating Agreement — ${agreement.company_name}`,
      documentSha256,
      completedAt: now,
      consentText: OA_CONSENT_TEXT,
      signers: certSigners,
    })
    finalBytes = await pdf.save()
  } catch (e) {
    return { ok: false, error: `render/certificate: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Store the executed instrument BEFORE flipping status.
  const pdfPath = `${agreement.token}/oa-signed-${Date.now()}.pdf`
  const { error: pdfUpErr } = await supabaseAdmin.storage
    .from(SIGNATURE_BUCKET)
    .upload(pdfPath, Buffer.from(finalBytes), { contentType: "application/pdf", upsert: true })
  if (pdfUpErr) return { ok: false, error: `store executed PDF: ${pdfUpErr.message}` }

  const { data: flipped, error: flipErr } = await db
    .from("oa_agreements")
    .update({
      status: "signed",
      signed_at: agreement.signed_at ?? now,
      pdf_storage_path: pdfPath,
      signature_method: "electronic",
      signature_data: { members: allRows.map(r => r.member_name), signed_date: now, multi_signer: isMMLLC },
      updated_at: now,
    })
    .eq("id", agreement.id)
    // Flip ONLY from a pre-terminal state. `.neq('status','signed')` alone would
    // also match a 'voided' row — and die-on-change can void this agreement in the
    // seconds this function spends rendering the PDF (a member edit fires exactly
    // when signing has stalled). Resurrecting a voided agreement to 'signed' would
    // execute a document built from the OLD, now-invalid roster. Whitelisting the
    // live states makes a mid-render void win: the flip finds no row and we bail.
    .in("status", ["sent", "viewed", "draft", "partially_signed"])
    .select("id")
  if (flipErr) return { ok: false, error: `flip to signed: ${flipErr.message}` }
  if (!flipped || flipped.length === 0) return { ok: true, skipped: "already_signed" }

  // Filing to Drive + formation side-effects — owned by /api/oa-signed. The
  // executed PDF is already stored and the agreement is 'signed', so a failure here
  // does NOT lose the instrument — but the client's Drive/portal copy would be
  // missing. The sweep won't catch it (it only looks at non-signed rows), so make a
  // failure LOUD rather than silent; oa-signed's own upsert is idempotent on re-run.
  try {
    const res = await fetch(`${APP_BASE_URL}/api/oa-signed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalWebhookServerHeaders() },
      body: JSON.stringify({ oa_id: agreement.id, token: agreement.token }),
    })
    if (!res.ok) {
      await reportSystemError({
        source: "server",
        route: "/api/oa-signed",
        method: "POST",
        message: `OA executed + stored but filing to Drive/portal failed (HTTP ${res.status}) — re-post /api/oa-signed for oa ${agreement.id}`,
        context: { oa_id: agreement.id, token: agreement.token, company: agreement.company_name },
      }).catch(() => {})
    }
  } catch (e) {
    await reportSystemError({
      source: "server",
      route: "/api/oa-signed",
      method: "POST",
      message: `OA executed + stored but the filing call threw — re-post /api/oa-signed for oa ${agreement.id}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      context: { oa_id: agreement.id, token: agreement.token, company: agreement.company_name },
    }).catch(() => {})
  }

  return { ok: true, pdfPath }
}
