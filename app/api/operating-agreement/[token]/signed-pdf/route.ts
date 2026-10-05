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
import { oaReadGate } from "@/lib/oa/read-gate"
import { signedPdfGate } from "@/lib/oa/signed-pdf-gate"

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // Every gate the page's own data route applies (lib/oa/read-gate.ts).
  const access = await oaReadGate(req, token, { rateKey: "oa-signed-pdf", rateMax: 10, logTag: "oa/signed-pdf" })
  if (!access.ok && access.response) return access.response
  const agreement = access.agreement

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
