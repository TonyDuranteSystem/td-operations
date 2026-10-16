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
import { newYorkToday, endOfYearIso, termMonthsThroughYearEnd } from "@/lib/lease/agreement-v2"
import { contactOperatingAddress, CONTACT_ADDRESS_COLUMNS } from "@/lib/lease/operating-address"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const code = typeof body.code === "string" ? body.code : ""
  const pdfPath = typeof body.pdf_storage_path === "string" ? body.pdf_storage_path : ""
  // one line of plain text: control characters / line breaks become spaces (it is read back by staff tools)
  const operatingAddress = typeof body.operating_address === "string" ? body.operating_address.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 300) : ""
  // template v2: the date the page printed next to both signatures — must still be today in New York when the signature lands
  const printedDate = typeof body.signing_date === "string" ? body.signing_date : ""
  // template v2: the company number and name the page showed (the PMB and the parties are printed in the agreement)
  const printedSuite = typeof body.suite_number === "string" ? body.suite_number : ""
  const printedCompany = typeof body.tenant_company === "string" ? body.tenant_company : ""
  const printedSigner = typeof body.tenant_contact_name === "string" ? body.tenant_contact_name : ""
  const printedTitle = typeof body.tenant_title === "string" ? body.tenant_title : ""

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
    .select("*")
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
  // template v2: Section 1.1's Operating Address is the signer's address in the CRM when there is one (the page printed it read-only);
  // only when the CRM has none does the client state where the business is really run. Either way it is part of what they sign.
  const isV2 = (lease.template_version ?? 1) === 2
  let crmAddress: string | null = null
  if (isV2 && lease.contact_id) {
    const { data: contact } = await db.from("contacts").select(CONTACT_ADDRESS_COLUMNS).eq("id", lease.contact_id).maybeSingle()
    crmAddress = contactOperatingAddress(contact)?.text ?? null
  }
  if (isV2 && !crmAddress && operatingAddress.length < 5) {
    return NextResponse.json({ error: "Please enter your Operating Address (where your business is run day to day) before signing." }, { status: 400 })
  }
  // the CRM address the page printed must still be the CRM address now (staff changed the contact while the page was open -> reload)
  if (isV2 && crmAddress && (typeof body.operating_address !== "string" || body.operating_address !== crmAddress)) {
    return NextResponse.json(
      { error: "The address in your agreement was updated while you had it open. The page will reload — please review it and sign again.", code: "lease_changed" },
      { status: 409 },
    )
  }

  // The signed PDF carries the company number and name the page printed. If staff changed either while the page was open (a number
  // change moves every unsigned lease), the PDF would contradict the record — refuse and make the client reload.
  if (isV2 && (printedSuite !== lease.suite_number || printedCompany !== lease.tenant_company ||
    printedSigner !== lease.tenant_contact_name || printedTitle !== (lease.tenant_title ?? ""))) {
    return NextResponse.json(
      { error: "This agreement was updated while you had it open. The page will reload — please review it and sign again.", code: "lease_changed" },
      { status: 409 },
    )
  }

  // The signed PDF carries the date the page printed; the record carries today's date in New York. They must be the same day —
  // otherwise (a tab left open past midnight) the PDF and the record would disagree about the Effective Date.
  if (isV2 && printedDate !== newYorkToday()) {
    return NextResponse.json(
      { error: "The date changed while this page was open, so the printed date is out of date. The page will reload — please sign again.", code: "date_changed" },
      { status: 409 },
    )
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
  // v2: the Effective Date is the date of the last signature, and the term runs from it to December 31 of that year — set here,
  // on the server, in New York time (the same date the page printed next to both signatures).
  const signedDay = isV2 ? printedDate : newYorkToday() // v2: already checked equal to today in New York above — no second clock read
  const v2Fields = isV2
    ? { operating_address: crmAddress ?? operatingAddress, effective_date: signedDay, term_start_date: signedDay, term_end_date: endOfYearIso(signedDay), term_months: termMonthsThroughYearEnd(signedDay) }
    : {}
  const { data: updated, error } = await db
    .from("lease_agreements")
    .update({
      status: "signed",
      signed_at: new Date().toISOString(),
      pdf_storage_path: pdfPath,
      ...v2Fields,
    })
    .eq("id", lease.id)
    .neq("status", "signed")
    .select("id")
    .maybeSingle()
  if (error) {
    // the database refuses a lease whose suite is no longer its company's (e.g. the company was closed and the number was reused)
    if (error.code === "23514") {
      return NextResponse.json({ error: "This lease is no longer valid — please contact Tony Durante LLC for a new one." }, { status: 409 })
    }
    return NextResponse.json({ error: "Failed to record signature" }, { status: 500 })
  }
  if (!updated) return NextResponse.json({ error: "Already signed" }, { status: 409 })

  return NextResponse.json({ ok: true })
}
