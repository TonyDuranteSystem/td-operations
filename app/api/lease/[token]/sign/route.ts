/**
 * POST /api/lease/[token]/sign  { code, pdf_storage_path }
 *
 * Replaces the client-side `supabasePublic.from('lease_agreements').update(...)`
 * that finalized a signed lease with the anon key — any caller holding just the
 * public anon key could set ANY lease's status to "signed" with an arbitrary
 * `pdf_storage_path`, with no real signing having happened. The PDF itself is
 * still uploaded client-side to the `signed-leases` bucket (a separate, already
 * accepted exposure class — storage-object writes, not this route's concern);
 * this route only gates the row write that actually finalizes the lease.
 *
 * Same access-code verification as app/api/lease/[token]/fetch/route.ts —
 * constant-time, rate-limited, fails closed. NO staff-preview bypass at all:
 * signing is a real, one-time client act — the page's own handleSign refuses
 * to even attempt it in admin preview, and this route requires a genuine
 * matching access code unconditionally, so there is nothing for a preview
 * flag to bypass here.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const code = typeof body.code === "string" ? body.code : ""
  const pdfPath = typeof body.pdf_storage_path === "string" ? body.pdf_storage_path : ""

  if (!pdfPath) {
    return NextResponse.json({ error: "pdf_storage_path required" }, { status: 400 })
  }
  // The uploaded PDF's path must live under this lease's own token prefix —
  // otherwise a caller who knows this route's shape could point a completed
  // lease at a PDF uploaded for a DIFFERENT lease's token.
  if (!pdfPath.startsWith(`${token}/`)) {
    return NextResponse.json({ error: "pdf_storage_path does not match this lease" }, { status: 400 })
  }

  const { data: lease } = await db
    .from("lease_agreements")
    .select("id, access_code, status")
    .eq("token", token)
    .maybeSingle()
  if (!lease) {
    return NextResponse.json({ error: "Lease not found." }, { status: 404 })
  }

  const codeErr = accessCodeError(req, { token, expected: lease.access_code, provided: code, isPreview: false })
  if (codeErr) return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })

  if (lease.status === "signed") {
    return NextResponse.json({ error: "Already signed" }, { status: 409 })
  }

  // Confirm the PDF this request claims to point at actually exists before
  // finalizing the lease — otherwise a caller who skips the browser's own
  // upload step (or races it) could flip the lease to "signed" against a
  // path with nothing behind it, permanently stranding the record with no
  // real signed document and no way to re-trigger the sign flow.
  const slashIdx = pdfPath.lastIndexOf("/")
  const folder = pdfPath.slice(0, slashIdx)
  const filename = pdfPath.slice(slashIdx + 1)
  const { data: listed, error: listErr } = await db.storage
    .from("signed-leases")
    .list(folder, { search: filename })
  if (listErr || !listed?.some((f: { name: string }) => f.name === filename)) {
    return NextResponse.json({ error: "Signed PDF not found — please try signing again." }, { status: 400 })
  }

  // Double-predicate write guard, same shape as every other signing route
  // converted today: the read-time check above can't stop two near-simultaneous
  // submits, so the same condition is repeated on the UPDATE itself.
  const { data: updated, error } = await db
    .from("lease_agreements")
    .update({
      status: "signed",
      signed_at: new Date().toISOString(),
      pdf_storage_path: pdfPath,
    })
    .eq("id", lease.id)
    .neq("status", "signed")
    .select("id")
    .maybeSingle()
  if (error) return NextResponse.json({ error: "Failed to record signature" }, { status: 500 })
  if (!updated) return NextResponse.json({ error: "Already signed" }, { status: 409 })

  return NextResponse.json({ ok: true })
}
