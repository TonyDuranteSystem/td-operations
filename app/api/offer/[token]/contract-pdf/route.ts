/**
 * GET /api/offer/[token]/contract-pdf?code=<accessCode>[&preview=td]  (renewals: ?pass=<grant>)
 *
 * Returns { url } — a short-lived signed URL to the client's OWN signed contract PDF.
 * Token-gated, NOT session-gated (added to middleware PUBLIC_PREFIXES). REPLACES the
 * public contract page's old anon `list()` + `download(newest)` so the signed-contracts
 * bucket no longer needs to be anon-readable.
 *
 * CREDENTIAL: the offer's `access_code` (a random UUID), verified SERVER-SIDE with the
 * same constant-time, rate-limited guard the lease route uses. The offer TOKEN alone is
 * NOT enough — tokens are human-guessable (`slugifyName(clientName)-YEAR`), so requiring
 * the unguessable access code is what stops a name-based enumeration of signed contracts
 * (bug-hunter finding, dev_task 97177e49). Verified safe: all 103 signed contracts have a
 * non-null offer access_code, so requiring it breaks no existing client.
 *
 * Security: signs the DB-RECORDED path (`contracts.pdf_path`), never a folder listing —
 * a planted object cannot be served. Fails CLOSED (404) when there is no signed contract.
 * A single offer can have several contract rows (renewals / re-signs); the LATEST wins.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { resolvePublicOfferAccess } from "@/lib/offers/public-offer-access"
import { createRecordedSignedUrl } from "@/lib/storage/signed-download"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const url = new URL(req.url)

  if (!token) {
    return NextResponse.json({ error: "Signed contract not available." }, { status: 404 })
  }

  // One credential rule for every public offer route (N0, dev job f907220c): the offer's
  // access code, a renewal agreement's portal pass/grant, or a real staff preview.
  const access = await resolvePublicOfferAccess(
    req,
    {
      token,
      code: url.searchParams.get("code") || "",
      pass: url.searchParams.get("pass") || "",
      preview: url.searchParams.get("preview") === "td",
    },
    { offerColumns: "token, access_code", renewalColumns: "id, token" },
  )
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })

  // Latest contract row for this offer (renewals/re-signs create additional rows).
  const { data: rows } = await db
    .from("contracts")
    .select("id, pdf_path, created_at")
    .eq("offer_token", token)
    .order("created_at", { ascending: false })
    .limit(1)

  const contract = Array.isArray(rows) ? rows[0] : null
  if (!contract?.pdf_path) {
    return NextResponse.json({ error: "Signed contract not available." }, { status: 404 })
  }

  const signedUrl = await createRecordedSignedUrl("signed-contracts", contract.pdf_path, 60)
  if (!signedUrl) {
    return NextResponse.json({ error: "Signed contract not available." }, { status: 404 })
  }

  return NextResponse.json({ url: signedUrl })
}
