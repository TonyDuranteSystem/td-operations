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
import { checkRateLimit, recordLoginFailure } from "@/lib/portal/rate-limit"
import { clientIp } from "@/lib/esign/request-meta"
import { verifyOaPass } from "@/lib/oa/portal-pass"
import {
  OA_AGREEMENT_SELECT,
  OA_SIGNATURE_SELECT,
  assertNoSecrets,
  emailGateFor,
  emailGateMatches,
  resolveSignerIndex,
  signerLinkState,
  toPublicAgreement,
  toPublicSignature,
} from "@/lib/oa/public-view"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const VOIDED_MESSAGE =
  "This Operating Agreement is no longer valid. Please generate a new one from your portal, or contact support@tonydurante.us."
const REVOKED_MESSAGE =
  "This signing link is no longer valid because the company's members changed. Please ask the company owner to re-issue it from the portal, or contact support@tonydurante.us."
const EXPIRED_MESSAGE =
  "This signing link has expired. Please ask the company owner to re-send it from the portal, or contact support@tonydurante.us."

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const signerCode = url.searchParams.get("signer")
  const passToken = url.searchParams.get("pass")
  // The email-gate answer arrives in a HEADER, never the query string. A query
  // param would put the client's address into every access log and referrer for
  // the life of the deployment — this change exists to stop that class of leak,
  // so it must not introduce a smaller version of it.
  const email = req.headers.get("x-oa-email")
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  // Throughput cap — the ONLY thing standing between an access-code holder (or a
  // legitimate co-signer) and brute-forcing the 8-hex per-signer code space,
  // which the access-code lockout does not cover (a correct shared code clears
  // that counter). Keyed by IP + token.
  const rlKey = `oa-fetch:${clientIp(req) || "unknown"}:${token}`
  const rl = checkRateLimit(rlKey, 30, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait a moment and try again." }, { status: 429 })
  }

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

  // A voided agreement is dead — block the READ, not only signing. This does not
  // depend on the best-effort code rotation: even if rotation failed, the void
  // status alone withholds the document (EIN, every member's name/address/split).
  // The portal wrapper already routes a voided OA to "outdated — generate a new
  // one" before it ever loads this, so a client never reaches this branch.
  if (agreement.status === "voided") {
    return NextResponse.json({ error: VOIDED_MESSAGE }, { status: 410 })
  }

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
    // A wrong signer code is a brute-force probe of the per-signer space — make
    // it cost against the shared IP+token lockout, exactly like a wrong code.
    recordLoginFailure(`esign:${clientIp(req) || "unknown"}:${token}`)
    return NextResponse.json({ error: "Invalid signing link." }, { status: 403 })
  }

  // Die-on-change + expiry: a specific signer's emailed link can be dead even
  // though the shared access code is right. A revoked link (membership changed)
  // or an expired one blocks the READ too (Antonio, 2026-08-11) — no document is
  // returned. A SIGNED row is never blocked (expiry/revocation never un-sign).
  if (signerIndex !== null) {
    const row = signatures.find((s: { member_index: number }) => s.member_index === signerIndex)
    const state = row ? signerLinkState(row) : "ok"
    if (state === "revoked") return NextResponse.json({ error: REVOKED_MESSAGE }, { status: 403 })
    if (state === "expired") return NextResponse.json({ error: EXPIRED_MESSAGE }, { status: 403 })
  }

  // A short-lived signed pass, minted by the contact-gated portal wrapper (a
  // logged-in member) or by CRM staff preview, bound to THIS agreement. It
  // replaces the spoofable bare `?portal=true` / `?preview=td` email-gate skip.
  const pass = passToken ? await verifyOaPass(passToken, agreement.id) : null
  const isStaffPreviewPass = pass?.kind === "staff_preview"

  // Email gate. It is skipped ONLY by, in order of strength:
  //   1. a REAL staff session (isStaffPreview) — rare on this client-facing host,
  //   2. a valid OA pass bound to this agreement (portal member or staff preview),
  //   3. a valid, unexpired, unrevoked per-signer code (the co-signer's own
  //      credential, delivered to their own mailbox — the address the gate would
  //      ask for is already proven by holding the code).
  // The bare `?portal=true` and `?preview=td` flags NO LONGER skip it — they are
  // trivially appended by anyone holding the shared code, and that is exactly the
  // trick door this change closes.
  const skipEmailGate = isPreview || !!pass || signerIndex !== null
  const gateAddress = skipEmailGate ? null : emailGateFor(agreement, signatures, signerIndex)
  if (gateAddress && !emailGateMatches(gateAddress, email)) {
    // No document data in this response — the point of the gate is that an
    // unverified caller receives nothing, including the address being matched.
    return NextResponse.json({ requiresEmail: true, companyName: agreement.company_name })
  }

  // View tracking — server-side, best effort, never blocks the read. Suppressed
  // for staff viewing (a real session OR a staff-preview pass) so staff opening
  // the document never looks like the client did. A portal-member pass counts as
  // a genuine view. The bare `?preview=td` flag no longer suppresses tracking —
  // it authenticates nothing now, so a request carrying it is treated as a
  // client, which is what stops it from silently poisoning the "client viewed"
  // signal only when it was actually staff.
  const suppressTracking = isPreview || isStaffPreviewPass
  if (!suppressTracking && !agreement.signed_at) {
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
