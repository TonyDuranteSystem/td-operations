/**
 * POST /api/esign/envelopes — create a draft e-sign envelope from an uploaded
 * PDF + a field/signer layout. Staff-only (dashboard auth).
 *
 * multipart/form-data:
 *   pdf:     File (the source PDF)
 *   payload: JSON string {
 *     document_name, description?, routing_order?,
 *     signers: [{ name, email?, contact_id?, role_label?, signing_order? }],
 *     fields:  [{ field_type, page_index, pos_x, pos_y, width, height,
 *                 required?, placeholder?, font_size?, signer_index }],
 *     owner_account_id?, contact_id?, service_delivery_id?
 *   }
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { validatePdfUpload, scanForMalware } from "@/lib/esign/upload-guard"
import { createEsignEnvelope, type EsignFieldInput, type EsignSignerInput } from "@/lib/operations/esign"

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 })
  }

  const file = form.get("pdf")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A PDF file is required." }, { status: 400 })
  }

  const payloadRaw = form.get("payload")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any
  try {
    payload = JSON.parse(typeof payloadRaw === "string" ? payloadRaw : "{}")
  } catch {
    return NextResponse.json({ error: "Invalid payload JSON." }, { status: 400 })
  }

  const document_name = typeof payload.document_name === "string" ? payload.document_name.trim() : ""
  if (!document_name) return NextResponse.json({ error: "A document name is required." }, { status: 400 })

  const signers: EsignSignerInput[] = Array.isArray(payload.signers) ? payload.signers : []
  const fields: EsignFieldInput[] = Array.isArray(payload.fields) ? payload.fields : []
  if (!signers.length) return NextResponse.json({ error: "At least one signer is required." }, { status: 400 })
  if (!fields.length) return NextResponse.json({ error: "Place at least one field before saving." }, { status: 400 })

  const bytes = new Uint8Array(await file.arrayBuffer())

  const valid = await validatePdfUpload(bytes)
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 })

  const scan = await scanForMalware(bytes)
  if (!scan.clean) {
    return NextResponse.json({ error: "The file failed a security scan and was rejected." }, { status: 400 })
  }

  // On production the signing link must use the stable public domain (APP_BASE_URL
  // = app.tonydurante.us); never the internal CRM host (R005). On preview/sandbox
  // there is no fixed domain that carries this code, so keep the link on the same
  // deployment by using the request origin.
  const proto = req.headers.get("x-forwarded-proto") || "https"
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host")
  const requestOrigin = host ? `${proto}://${host}` : null
  const baseUrl = process.env.VERCEL_ENV === "production" ? null : requestOrigin

  try {
    const result = await createEsignEnvelope({
      document_name,
      baseUrl,
      description: typeof payload.description === "string" ? payload.description : null,
      pdfBuffer: Buffer.from(bytes),
      fileName: (file.name || "document.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
      pageCount: valid.pageCount ?? 1,
      fields,
      signers,
      owner_account_id: typeof payload.owner_account_id === "string" ? payload.owner_account_id : null,
      contact_id: typeof payload.contact_id === "string" ? payload.contact_id : null,
      origin: "staff",
      routing_order: payload.routing_order === "parallel" ? "parallel" : "sequential",
      created_by: user?.email || "staff",
      service_delivery_id: typeof payload.service_delivery_id === "string" ? payload.service_delivery_id : null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create the envelope." },
      { status: 400 },
    )
  }
}
