/**
 * GET /api/operating-agreement/[token]/fetch?code=<accessCode>[&signer=<code>][&email=<address>][&preview=td]
 *
 * The ONLY way a public operating-agreement page may obtain agreement data.
 *
 * Replaces a browser-side `select('*')` on `oa_agreements` + `oa_signatures`
 * that ran with the anon key and compared the access code CLIENT-SIDE, i.e.
 * after the whole row had already been delivered. See lib/oa/public-view.ts for
 * the full description of what that exposed and why the field whitelist is half
 * the fix.
 *
 * Three gates, all server-side, all fail-closed:
 *   1. access code — constant-time, rate-limited, shared with the e-sign routes
 *      (lib/esign/access-guard.ts).
 *   2. admin preview — requires a REAL staff session, never the bare query flag
 *      (lib/auth/staff-preview.ts, 2026-07-21 incident). The OA pages were the
 *      two surfaces that incident missed, because they are pages, not routes.
 *   3. email gate — the address is compared here and never sent to the browser.
 *
 * View tracking moved here too. It was two anon UPDATE calls from the page; the
 * server does it with the service key, so the browser no longer needs write
 * access for merely opening the document.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import {
  OA_AGREEMENT_SELECT,
  OA_SIGNATURE_SELECT,
  assertNoSecrets,
  emailGateFor,
  emailGateMatches,
  resolveSignerIndex,
  toPublicAgreement,
  toPublicSignature,
} from "@/lib/oa/public-view"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const signerCode = url.searchParams.get("signer")
  const email = url.searchParams.get("email")
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

  const { data: sigRows } = await db
    .from("oa_signatures")
    .select(OA_SIGNATURE_SELECT)
    .eq("oa_id", agreement.id)
    .order("member_index")
  const signatures = sigRows ?? []

  // A per-member signing code identifies WHICH member is at the keyboard. An
  // absent or unrecognised code is not an error — the single-member flow has
  // none — but it must never silently resolve to member 0.
  const signerIndex = resolveSignerIndex(signatures, signerCode)
  if (signerCode && signerIndex === null) {
    return NextResponse.json({ error: "Invalid signing link." }, { status: 403 })
  }

  // Email gate. Staff preview skips it, exactly as the pages did before.
  // `?portal=true` marks the embedded portal iframe, which skips the EMAIL gate
  // only — exactly as both pages did before. It is NOT a code bypass: the
  // access code is still required above. It cannot be upgraded to a session
  // check here because the iframe is served from a different host than the
  // portal, so the portal's session cookie is not present on this request.
  // Residual, unchanged by this fix: anyone already holding the code can append
  // this flag to skip the email step.
  const portalMode = url.searchParams.get("portal") === "true"
  const gateAddress = isPreview || portalMode ? null : emailGateFor(agreement, signatures, signerIndex)
  if (gateAddress && !emailGateMatches(gateAddress, email)) {
    // No document data in this response — the point of the gate is that an
    // unverified caller receives nothing, including the address being matched.
    return NextResponse.json({ requiresEmail: true, companyName: agreement.company_name })
  }

  // View tracking — server-side, best effort, never blocks the read. Skipped in
  // preview so staff opening the document does not look like the client did.
  if (!isPreview && !agreement.signed_at) {
    const now = new Date().toISOString()
    try {
      await db
        .from("oa_agreements")
        .update({
          view_count: (agreement.view_count ?? 0) + 1,
          viewed_at: now,
          status: ["draft", "sent"].includes(agreement.status) ? "viewed" : agreement.status,
        })
        .eq("id", agreement.id)
      if (signerIndex !== null) {
        const sig = signatures.find((s: { member_index: number }) => s.member_index === signerIndex)
        if (sig && sig.status !== "signed") {
          await db
            .from("oa_signatures")
            .update({ status: "viewed", view_count: (sig.view_count ?? 0) + 1, updated_at: now })
            .eq("id", sig.id)
        }
      }
    } catch {
      // Tracking is not worth failing a signing session over.
    }
  }

  const payload = {
    requiresEmail: false,
    isPreview,
    currentSignerIndex: signerIndex,
    agreement: toPublicAgreement(agreement),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signatures: signatures.map((s: any) => toPublicSignature(s)),
  }
  assertNoSecrets(payload)
  return NextResponse.json(payload)
}
