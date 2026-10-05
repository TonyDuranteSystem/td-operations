/**
 * GET /api/operating-agreement/[token]/signature-image?code=<accessCode>&index=<memberIndex>[&signer=<code>][&pass=<pass>][&preview=td]
 *
 * Streams one member's SIGNATURE PICTURE for the agreement page.
 *
 * ⛔ WHY THIS EXISTS. On a multi-member agreement the page shows each signed
 * member's signature. It used to download those pictures from the private
 * `signed-oa` bucket with the anonymous browser client; since the 2026-07-22
 * lockdown that read is refused, the page swallowed the error, and every signed
 * member showed only "Signed on <date>" with no signature (reproduced on the
 * sandbox QA fixture 2026-10-05: both picture downloads returned 400). The
 * picture is read here with the service key instead, after the SAME gates as the
 * page's data route (`lib/oa/read-gate.ts`).
 *
 * Only a member whose row says `signed` has a picture; the path is the one the
 * server recorded for that row, confined to this agreement's folder and to that
 * member's own file by `resolveSignatureImagePath`. A voided agreement shows none.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { oaReadGate } from "@/lib/oa/read-gate"
import { resolveSignatureImagePath } from "@/lib/oa/signature-image-path"

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const idxRaw = new URL(req.url).searchParams.get("index")
  const index = idxRaw !== null && /^\d{1,3}$/.test(idxRaw) ? Number(idxRaw) : NaN

  // A page shows up to a handful of pictures at once, so the cap is higher than the PDF route's.
  const access = await oaReadGate(req, token, { rateKey: "oa-sig-image", rateMax: 60, logTag: "oa/signature-image" })
  if (!access.ok && access.response) return access.response
  const agreement = access.agreement

  if (agreement.status === "voided") {
    return NextResponse.json({ error: "This Operating Agreement is no longer valid." }, { status: 410 })
  }
  if (!Number.isInteger(index)) return NextResponse.json({ error: "Missing signature number." }, { status: 400 })

  const row = access.signatures.find((s: { member_index: number }) => s.member_index === index)
  if (!row || row.status !== "signed") return NextResponse.json({ error: "No signature on file." }, { status: 404 })

  const target = resolveSignatureImagePath(agreement.token, index, row.signature_image_path)
  if (!target.ok || !target.path) return NextResponse.json({ error: "No signature on file." }, { status: 404 })

  const { data: file, error: dlErr } = await supabaseAdmin.storage.from("signed-oa").download(target.path)
  if (dlErr || !file) {
    console.error("[oa/signature-image] storage download failed:", token, index, dlErr)
    return NextResponse.json({ error: "The signature could not be read right now." }, { status: 502 })
  }
  return new NextResponse(await file.arrayBuffer(), {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
  })
}
