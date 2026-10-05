/**
 * The READ gate for the operating-agreement routes that serve a stored object
 * (`signed-pdf`, `signature-image`) — the same rules the page's own data route
 * (`app/api/operating-agreement/[token]/fetch/route.ts`) applies before it shows
 * the agreement, in one place so the object routes can never drift easier than
 * the page:
 *
 *   1. throughput limit (the access guard throttles WRONG codes, not a right one)
 *   2. the agreement exists (a read failure is 503, not "not found")
 *   3. access code — shared constant-time guard
 *   4. per-signer link: unknown code is a probe (counts against the shared lockout),
 *      revoked / expired links cannot read either
 *   5. e-mail gate (`x-oa-email` header) — skipped ONLY by a real staff session, a
 *      pass bound to this agreement, a valid per-signer code, or a download ticket
 *
 * Returns the loaded agreement + signatures on success, or the ready response.
 * FLAT shape on purpose (the repo compiles with `strict: false`, which does not
 * narrow a discriminated union on a boolean).
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { checkRateLimit, recordLoginFailure } from "@/lib/portal/rate-limit"
import { clientIp } from "@/lib/esign/request-meta"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { verifyOaDownloadTicket, verifyOaPass } from "@/lib/oa/portal-pass"
import { OA_AGREEMENT_SELECT, OA_SIGNATURE_SELECT, emailGateFor, emailGateMatches, resolveSignerIndex, signerLinkState } from "@/lib/oa/public-view"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export interface OaReadGateResult {
  ok: boolean
  /** Ready-to-return response — only when not ok. */
  response: NextResponse | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agreement: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signatures: any[]
  signerIndex: number | null
}

function refuse(body: { error: string }, status: number): OaReadGateResult {
  return { ok: false, response: NextResponse.json(body, { status }), agreement: null, signatures: [], signerIndex: null }
}

export async function oaReadGate(
  req: NextRequest,
  token: string,
  opts: { rateKey: string; rateMax: number; logTag: string },
): Promise<OaReadGateResult> {
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const signerCode = url.searchParams.get("signer")
  const passToken = url.searchParams.get("pass")
  const email = req.headers.get("x-oa-email")
  const ticket = req.headers.get("x-oa-ticket")
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  const rl = checkRateLimit(`${opts.rateKey}:${clientIp(req) || "unknown"}:${token}`, opts.rateMax, 60_000)
  if (!rl.allowed) return refuse({ error: "Too many requests. Please wait a moment and try again." }, 429)

  const { data: agreement, error: agreementErr } = await db
    .from("oa_agreements")
    .select(OA_AGREEMENT_SELECT)
    .eq("token", token)
    .maybeSingle()
  if (agreementErr) {
    console.error(`[${opts.logTag}] agreement lookup failed:`, agreementErr)
    return refuse({ error: "Could not load the Operating Agreement. Please try again, or contact support@tonydurante.us." }, 503)
  }
  if (!agreement) return refuse({ error: "Operating Agreement not found." }, 404)

  const codeErr = accessCodeError(req, { token, expected: agreement.access_code, provided: code, isPreview })
  if (codeErr) return refuse({ error: codeErr.error }, codeErr.status)

  const { data: sigRows } = await db
    .from("oa_signatures")
    .select(OA_SIGNATURE_SELECT)
    .eq("oa_id", agreement.id)
    .order("member_index")
  const signatures = sigRows ?? []

  const signerIndex = resolveSignerIndex(signatures, signerCode)
  if (signerCode && signerIndex === null) {
    // A wrong signer code probes the per-signer code space (a right one skips the e-mail gate):
    // make it cost against the same shared IP+token lockout the data route uses.
    recordLoginFailure(`esign:${clientIp(req) || "unknown"}:${token}`)
    return refuse({ error: "Invalid signing link." }, 403)
  }
  if (signerIndex !== null) {
    const row = signatures.find((s: { member_index: number }) => s.member_index === signerIndex)
    const state = row ? signerLinkState(row) : "ok"
    if (state === "revoked") {
      return refuse({ error: "This signing link is no longer valid because the company's members changed. Please ask the company owner to re-issue it from the portal." }, 403)
    }
    if (state === "expired") {
      return refuse({ error: "This signing link has expired. Please ask the company owner to re-send it from the portal." }, 403)
    }
  }

  const pass = passToken ? await verifyOaPass(passToken, agreement.id) : null
  // A download ticket is what the data route hands a signed agreement's page AFTER it passed every
  // gate (lib/oa/portal-pass.ts) — it outlives the 2-minute page-load pass.
  const hasTicket = ticket ? await verifyOaDownloadTicket(ticket, agreement.id) : false
  const skipEmailGate = isPreview || !!pass || signerIndex !== null || hasTicket
  const gateAddress = skipEmailGate ? null : emailGateFor(agreement, signatures, signerIndex)
  if (gateAddress && !emailGateMatches(gateAddress, email)) {
    return refuse({ error: "Please confirm your e-mail address on the agreement page first." }, 403)
  }

  return { ok: true, response: null, agreement, signatures, signerIndex }
}
