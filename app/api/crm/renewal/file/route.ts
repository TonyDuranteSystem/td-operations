/**
 * Slice 9 — file an RA Renewal / Annual Report from a To-Do board card.
 *
 * Staff-only. Receives the receipt PDF (base64) + filed date, then calls the
 * existing `fileRenewal` engine which uploads the receipt to Drive with the
 * SOP filename, completes/advances the SD, and rolls the account's
 * ra_renewal_date / annual_report_due_date forward by a year.
 *
 * REV 4.1: receipt upload is REQUIRED on Mark Done — this route rejects a
 * request without receipt bytes.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { fileRenewal, type RenewalKind } from "@/lib/operations/file-renewal"

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Staff only" }, { status: 403 })

  let body: {
    account_id?: string
    delivery_id?: string | null
    kind?: string
    filed_date?: string
    receipt?: { file_name?: string; mime_type?: string; data_base64?: string }
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { account_id, delivery_id, kind, filed_date, receipt } = body
  if (!account_id) return NextResponse.json({ error: "account_id required" }, { status: 400 })
  if (kind !== "ra" && kind !== "ar") return NextResponse.json({ error: "kind must be 'ra' or 'ar'" }, { status: 400 })
  if (!filed_date || !/^\d{4}-\d{2}-\d{2}$/.test(filed_date)) {
    return NextResponse.json({ error: "filed_date (YYYY-MM-DD) required" }, { status: 400 })
  }
  if (!receipt?.data_base64) {
    return NextResponse.json({ error: "A receipt file is required to mark this done." }, { status: 400 })
  }

  let data: Buffer
  try {
    data = Buffer.from(receipt.data_base64, "base64")
  } catch {
    return NextResponse.json({ error: "Could not read the receipt file." }, { status: 400 })
  }
  if (data.length === 0) return NextResponse.json({ error: "The receipt file is empty." }, { status: 400 })

  try {
    const result = await fileRenewal({
      account_id,
      delivery_id: delivery_id ?? null,
      kind: kind as RenewalKind,
      filed_date,
      receipt: {
        file_name: receipt.file_name || "receipt.pdf",
        mime_type: receipt.mime_type || "application/pdf",
        data,
      },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "Filing failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
