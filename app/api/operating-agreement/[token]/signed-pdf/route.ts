/**
 * GET /api/operating-agreement/[token]/signed-pdf?code=<accessCode>[&signer=<code>][&preview=td]
 *
 * Streams the EXECUTED (signed) Operating Agreement — the object the server
 * recorded in `oa_agreements.pdf_storage_path`, read with the service key.
 *
 * ⛔ WHY THIS EXISTS. The signing page's "Download Signed PDF" button used to read
 * the `signed-oa` bucket with the anonymous browser client. That bucket has no
 * read policy for anonymous callers (closed 2026-07-22), so the read failed for
 * everyone except the browser session that had just signed, and the page then
 * claimed the PDF would be "ready once all members sign" — on a fully signed
 * agreement. Verified live on production 2026-10-05 against three signed
 * agreements. The draft counterpart is `../pdf/route.ts`.
 *
 * ACCESS: the SAME gates as the page's own data route (`../fetch/route.ts`) —
 * token + access code (shared guard, throttles wrong codes), the per-signer link
 * rules (revoked/expired links are dead for reading too), and the email gate
 * (answer in the `x-oa-email` header; skipped only by a real staff session, a
 * valid portal/staff pass bound to this agreement, or a valid per-signer code).
 * The executed agreement carries the EIN and every member's details, so it must
 * not be easier to reach than the page that shows it.
 * The file served is ONLY the recorded one, confined to this agreement's folder
 * by `resolveSignedPdfPath` — never "the newest object in the folder".
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { checkRateLimit, recordLoginFailure } from "@/lib/portal/rate-limit"
import { clientIp } from "@/lib/esign/request-meta"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { verifyOaDownloadTicket, verifyOaPass } from "@/lib/oa/portal-pass"
import { OA_AGREEMENT_SELECT, OA_SIGNATURE_SELECT, emailGateFor, emailGateMatches, resolveSignerIndex, signerLinkState } from "@/lib/oa/public-view"
import { signedPdfGate } from "@/lib/oa/signed-pdf-gate"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get("code") || ""
  const signerCode = url.searchParams.get("signer")
  const passToken = url.searchParams.get("pass")
  const email = req.headers.get("x-oa-email")
  const ticket = req.headers.get("x-oa-ticket")
  const isPreview = await isStaffPreview(url.searchParams.get("preview") === "td")

  // The access guard throttles wrong codes, not a caller holding a right one.
  const rl = checkRateLimit(`oa-signed-pdf:${clientIp(req) || "unknown"}:${token}`, 10, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment and try again." }, { status: 429 })
  }

  const { data: agreement, error: agreementErr } = await db
    .from("oa_agreements")
    .select(OA_AGREEMENT_SELECT)
    .eq("token", token)
    .maybeSingle()
  if (agreementErr) {
    console.error("[oa/signed-pdf] agreement lookup failed:", agreementErr)
    return NextResponse.json(
      { error: "Could not load the Operating Agreement. Please try again, or contact support@tonydurante.us." },
      { status: 503 },
    )
  }
  if (!agreement) return NextResponse.json({ error: "Operating Agreement not found." }, { status: 404 })

  const codeErr = accessCodeError(req, { token, expected: agreement.access_code, provided: code, isPreview })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  const { data: sigRows } = await db
    .from("oa_signatures")
    .select(OA_SIGNATURE_SELECT)
    .eq("oa_id", agreement.id)
    .order("member_index")
  const signatures = sigRows ?? []

  // A co-signer link that died (members changed / 15-day expiry) cannot read the document either.
  const signerIndex = resolveSignerIndex(signatures, signerCode)
  if (signerCode && signerIndex === null) {
    // A wrong signer code is a probe of the per-signer code space (a right one skips the email gate):
    // make it cost against the same shared IP+token lockout the data route uses.
    recordLoginFailure(`esign:${clientIp(req) || "unknown"}:${token}`)
    return NextResponse.json({ error: "Invalid signing link." }, { status: 403 })
  }
  if (signerIndex !== null) {
    const row = signatures.find((s: { member_index: number }) => s.member_index === signerIndex)
    const state = row ? signerLinkState(row) : "ok"
    if (state === "revoked") {
      return NextResponse.json({ error: "This signing link is no longer valid because the company's members changed. Please ask the company owner to re-issue it from the portal." }, { status: 403 })
    }
    if (state === "expired") {
      return NextResponse.json({ error: "This signing link has expired. Please ask the company owner to re-send it from the portal." }, { status: 403 })
    }
  }

  // Email gate — identical rule to the data route, so this file is never easier to reach than the page.
  const pass = passToken ? await verifyOaPass(passToken, agreement.id) : null
  // A download ticket is what the data route handed this page AFTER it passed every gate (see
  // lib/oa/portal-pass.ts) — it outlives the 2-minute page-load pass, which is the whole point.
  const hasTicket = ticket ? await verifyOaDownloadTicket(ticket, agreement.id) : false
  const skipEmailGate = isPreview || !!pass || signerIndex !== null || hasTicket
  const gateAddress = skipEmailGate ? null : emailGateFor(agreement, signatures, signerIndex)
  if (gateAddress && !emailGateMatches(gateAddress, email)) {
    return NextResponse.json({ error: "Please confirm your e-mail address on the agreement page first." }, { status: 403 })
  }

  const gate = signedPdfGate({ token: agreement.token, status: agreement.status, pdf_storage_path: agreement.pdf_storage_path })
  if (!gate.ok || !gate.path) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { data: file, error: dlErr } = await supabaseAdmin.storage.from("signed-oa").download(gate.path)
  if (dlErr || !file) {
    console.error("[oa/signed-pdf] storage download failed:", token, dlErr)
    return NextResponse.json(
      { error: "The signed copy could not be read right now. Please try again, or contact support@tonydurante.us." },
      { status: 502 },
    )
  }

  const name = `Operating_Agreement_${String(agreement.company_name || "company").replace(/[^A-Za-z0-9]+/g, "_")}.pdf`
  return new NextResponse(await file.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
