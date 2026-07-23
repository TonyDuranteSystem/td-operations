/**
 * GET /api/operating-agreement/[token]/pdf?code=<accessCode>[&preview=td]
 *
 * Streams the Operating Agreement as a PDF for the client to READ BEFORE SIGNING.
 *
 * ⛔ WHY THIS EXISTS.
 *
 * A client could see the agreement on screen but could not take a copy away. The
 * only PDF that ever existed was the one the browser produced at the moment of
 * signing, so the sole chance to get a reviewable copy was the preview step
 * BEFORE pressing "Create & Send". Close the tab and the only route to a PDF was
 * to sign it first — which is exactly backwards for a legal document someone
 * reasonably wants their accountant or their bank to read first. (Checked before
 * building: the portal documents list is display-only with no file behind it, and
 * the CRM has no "send the client a copy" action either.)
 *
 * The document is RENDERED ON DEMAND from the agreement row — nothing is stored.
 * That means the unsigned copy and the executed copy come from the same source
 * and cannot drift apart, and there is no file to go stale when the agreement is
 * regenerated.
 *
 * ANTONIO'S DECISION, 2026-07-23: no "DRAFT — NOT EXECUTED" watermark. The
 * unsigned copy is the agreement, with the signature blocks blank. Recorded here
 * because it is a deliberate choice with a consequence: an unsigned copy is
 * distinguishable from an executed one only by those blank blocks, so someone
 * could present it as though it were signed. That was raised and accepted.
 *
 * ACCESS: the same gate as the signing page itself — token plus access code,
 * verified server-side by the shared guard (constant-time, rate-limited).
 * Whoever can open the agreement to sign it can download it; nobody else.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { normalizeEntityType } from "@/lib/portal/entity-type"
import { generateOperatingAgreementPDF, type OASignatureBlock } from "@/lib/pdf/operating-agreement-pdf"
import { OA_AGREEMENT_SELECT, OA_SIGNATURE_SELECT } from "@/lib/oa/public-view"
import type { OAData, OAMember } from "@/lib/types/oa-templates"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const SIGNATURE_BUCKET = "signed-oa"

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  const { data: agreement } = await db
    .from("oa_agreements")
    .select(OA_AGREEMENT_SELECT)
    .eq("token", token)
    .maybeSingle()
  if (!agreement) {
    return NextResponse.json({ error: "Operating Agreement not found." }, { status: 404 })
  }

  const codeErr = accessCodeError(req, {
    token,
    expected: agreement.access_code,
    provided: code,
    isPreview,
  })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  const isMMLLC = normalizeEntityType(agreement.entity_type) === "MMLLC"
  const members: OAMember[] = Array.isArray(agreement.members) ? agreement.members : []

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

  // Signatures, when there are any. An unsigned agreement simply renders with the
  // blocks blank — the renderer already leaves an unsigned member's date empty
  // rather than inventing one, and never describes them as signed.
  let signatures: OASignatureBlock[] = []
  let soleSignaturePng: Uint8Array | null = null
  let soleSignedAt: string | null = agreement.signed_at ?? null

  const { data: sigRows } = await db
    .from("oa_signatures")
    .select(OA_SIGNATURE_SELECT)
    .eq("oa_id", agreement.id)
    .order("member_index")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = sigRows ?? []

  // Fetch each signature image with the SERVICE key. The browser cannot read this
  // bucket (no anon read policy), which is why a multi-member document rendered
  // in the browser fell back to text — here the server can, so the executed copy
  // shows the real signatures.
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

  if (isMMLLC && rows.length > 0) {
    signatures = await Promise.all(
      rows.map(async r => ({
        memberIndex: r.member_index,
        signedAt: r.status === "signed" ? r.signed_at : null,
        signaturePng: r.status === "signed" ? await imageFor(r.signature_image_path) : null,
      })),
    )
  } else if (!isMMLLC) {
    const sole = rows[0]
    if (sole?.status === "signed") {
      soleSignedAt = sole.signed_at ?? soleSignedAt
      soleSignaturePng = await imageFor(sole.signature_image_path)
    }
  }

  let pdf: Uint8Array
  try {
    pdf = await generateOperatingAgreementPDF({ data, signatures, soleSignaturePng, soleSignedAt })
  } catch (err) {
    console.error("[oa/pdf] render failed:", err)
    return NextResponse.json(
      { error: "Could not produce the document. Please try again, or contact support@tonydurante.us." },
      { status: 500 },
    )
  }

  const safeName = String(agreement.company_name || "Operating Agreement").replace(/[^A-Za-z0-9]+/g, "_")
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // `inline` so a click opens it in the browser's viewer — the client is
      // reading it, not filing it. They can still save from there.
      "Content-Disposition": `inline; filename="Operating_Agreement_${safeName}.pdf"`,
      "Cache-Control": "no-store",
    },
  })
}
