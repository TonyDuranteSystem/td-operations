/**
 * GET /api/operating-agreement/[token]/pdf?code=<accessCode>[&preview=td]
 *
 * Streams the UNSIGNED DRAFT of the Operating Agreement, for the client to READ
 * BEFORE SIGNING — or to print and sign by hand.
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
 * ⛔ DRAFT ONLY. THIS ROUTE NEVER SERVES AN EXECUTED AGREEMENT.
 *
 * That single constraint is what makes this route safe, and three separate
 * reviewers' blockers dissolve into it. Do not relax it:
 *
 *   1. It renders NO signatures, so it never reads the signature-image bucket.
 *      That bucket accepts uploads from anyone (its only policy is INSERT for
 *      role `public`) and the image path lives on a row anon can UPDATE, so a
 *      version of this route that fetched images had the SERVER pulling an
 *      attacker-chosen object with the service key. Nothing to fetch, nothing to
 *      exploit.
 *   2. There is no second rendering of the executed instrument. The signed PDF
 *      keeps exactly one producer and one download path (`resolveSignedPdfPath`,
 *      surfaced by the page's own "Download Signed PDF" button), so the two
 *      cannot disagree about what a client signed.
 *   3. The document says what it is. `draft: true` stamps every page and puts the
 *      preamble and the IN WITNESS WHEREOF recital into their unexecuted form —
 *      the legal reviewer's blocker was never the missing signature, it was that
 *      TD's own text asserted the document HAD been executed when it had not.
 *
 * A signed agreement asking for this route gets 409 and a pointer to its real
 * signed copy.
 *
 * ACCESS: the same gate as the signing page itself — token plus access code,
 * verified server-side by the shared guard. Whoever can open the agreement to
 * sign it can download the draft; nobody else.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { checkRateLimit, getRateLimitKey } from "@/lib/portal/rate-limit"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { normalizeEntityType } from "@/lib/portal/entity-type"
import { generateOperatingAgreementPDF } from "@/lib/pdf/operating-agreement-pdf"
import { OA_AGREEMENT_SELECT, toPublicMembers } from "@/lib/oa/public-view"
import type { OAData, OAMember } from "@/lib/types/oa-templates"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  // Throughput limit. The shared access guard throttles WRONG codes; it does not
  // throttle a caller holding a correct one — a success actively CLEARS the
  // failure counter. Every other route in this family streams a stored file,
  // while this one lays out a nine-article document and subsets two fonts per
  // request, so an unmetered loop on one valid link is real CPU. Nobody
  // legitimate downloads their own agreement ten times a minute.
  const rl = checkRateLimit(`${getRateLimitKey(req)}:oa-pdf`, 10, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment and try again." },
      { status: 429 },
    )
  }

  const { data: agreement, error: agreementErr } = await db
    .from("oa_agreements")
    .select(OA_AGREEMENT_SELECT)
    .eq("token", token)
    .maybeSingle()

  // Separate "the read failed" from "there is no such agreement". Collapsing them
  // tells a client holding a valid link that their legal document does not exist,
  // which is both alarming and false. A DUPLICATE token also lands here —
  // maybeSingle errors on multiple matches — so this is what surfaces the known
  // token-collision case instead of silently 404ing both agreements.
  if (agreementErr) {
    console.error("[oa/pdf] agreement lookup failed:", agreementErr)
    return NextResponse.json(
      { error: "Could not load the Operating Agreement. Please try again, or contact support@tonydurante.us." },
      { status: 503 },
    )
  }
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

  // ── Status gates ──────────────────────────────────────────────────────────
  // Both sit AFTER the access-code check, so neither can be used to probe which
  // agreements exist.

  // A VOIDED agreement is dead — staff void one precisely so the client stops
  // using it. Without this check a client holding the old link downloads a clean,
  // current-looking copy of a dead document and can hand it to a bank.
  //
  // The wording matters: "voided", not "superseded". Verified on production
  // 2026-07-23 — 21 agreements are voided and NOT ONE has a replacement, because
  // voiding is how staff unblock a stuck client, not how they reissue. Telling a
  // client their agreement "has been superseded" asserts a successor document
  // that does not exist. The portal already says the accurate thing.
  if (agreement.status === "voided") {
    return NextResponse.json(
      {
        error:
          "This Operating Agreement has been voided and is no longer valid. Please generate a new one from your portal, or contact support@tonydurante.us.",
      },
      { status: 410 },
    )
  }

  // A SIGNED agreement has a real executed copy; this route only makes drafts.
  // Rendering a blank one here would put two different documents behind the same
  // page — this one, and the executed PDF the signing page already offers.
  if (agreement.status === "signed") {
    return NextResponse.json(
      {
        error:
          "This Operating Agreement has been signed. Open your signed copy from the portal, or contact support@tonydurante.us.",
      },
      { status: 409 },
    )
  }

  // Multi-member is entity type AND more than one signer — the same test the
  // signing page and the filing route apply. Entity type alone is not enough:
  // production carries rows marked multi-member that hold NO member list and one
  // signer (a legacy generator still produces them), and treating those as
  // multi-member renders an agreement headed "Multi-Member LLC" with an empty
  // member table whose execution block reads "Sole Member / Manager".
  const isMMLLC =
    normalizeEntityType(agreement.entity_type) === "MMLLC" && (agreement.total_signers || 1) > 1
  // Strip the members blob the same way every other outbound path does. It
  // carries each member's email, dropped on the floor today only because the
  // template happens not to print it.
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

  let pdf: Uint8Array
  try {
    // No signatures, ever — see the DRAFT ONLY note at the top.
    pdf = await generateOperatingAgreementPDF({ data, draft: true })
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
      // reading it, not filing it. They can still save or print from there.
      "Content-Disposition": `inline; filename="Operating_Agreement_DRAFT_${safeName}.pdf"`,
      "Cache-Control": "no-store",
    },
  })
}
