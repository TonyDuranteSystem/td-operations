/**
 * POST /api/flows/[id]/send-for-signature
 *
 * Tax Return flow action (stage "Tax Return Prepared"). Takes the most recent
 * document uploaded against this service delivery, creates a signature request
 * linked to the SD, notifies the client, and advances the SD to
 * "Sent for Signature".
 *
 * Single source of truth for the advance side effects is advanceServiceDelivery
 * — we pass skip_notify:true and send our own tailored "ready to sign"
 * notification so the client gets ONE clear message, not a generic stage-move
 * notice plus a duplicate.
 *
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { advanceServiceDelivery } from "@/lib/service-delivery"
import { createSignatureRequest, fetchFlowDocumentPdf } from "@/lib/operations/signature"
import { createPortalNotification } from "@/lib/portal/notifications"

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id
    // service_delivery_id (signature_requests) / flow columns (documents) were
    // added by migration but the generated DB types aren't regenerated — query
    // those filters via an untyped surface (mirrors the other flow routes).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any

    // 1. Resolve the SD → account + current stage.
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, account_id, contact_id, stage, service_type")
      .eq("id", serviceDeliveryId)
      .single()
    if (sdErr || !sd || !sd.account_id) {
      return NextResponse.json({ success: false, error: "Flow (service delivery) not found" }, { status: 404 })
    }

    // 2. Guard: only sendable from the "Tax Return Prepared" stage.
    if (sd.stage !== "Tax Return Prepared") {
      return NextResponse.json(
        { success: false, error: `Can only send for signature from "Tax Return Prepared" (currently "${sd.stage}").` },
        { status: 409 },
      )
    }

    // 3. Idempotency: don't create a second request if one already exists for this SD.
    const { data: existing } = await db
      .from("signature_requests")
      .select("id")
      .eq("service_delivery_id", serviceDeliveryId)
      .limit(1)
    if (existing?.length) {
      return NextResponse.json(
        { success: false, error: "A signature request has already been created for this tax return." },
        { status: 409 },
      )
    }

    // 4. Find the most recent document uploaded against this SD.
    const { data: docs } = await db
      .from("documents")
      .select("file_name, drive_file_id")
      .eq("service_delivery_id", serviceDeliveryId)
      .order("created_at", { ascending: false })
      .limit(1)
    const doc = docs?.[0] as { file_name: string | null; drive_file_id: string | null } | undefined
    if (!doc?.drive_file_id) {
      return NextResponse.json(
        { success: false, error: "Upload the prepared tax return before sending it for signature." },
        { status: 400 },
      )
    }

    // 5. Fetch the PDF bytes (Drive in prod, Storage in sandbox).
    const pdfBuffer = await fetchFlowDocumentPdf(doc.drive_file_id)

    // 6. Create the signature request linked to this SD.
    const result = await createSignatureRequest({
      account_id: sd.account_id,
      contact_id: sd.contact_id ?? undefined,
      document_name: "Tax Return",
      description: "Please review and sign your prepared tax return.",
      pdfBuffer,
      fileName: doc.file_name || "tax-return.pdf",
      service_delivery_id: serviceDeliveryId,
      created_by: "flow-send-for-signature",
    })

    // 7. Notify the client (one tailored message; we skip the generic advance notice).
    await createPortalNotification({
      account_id: sd.account_id,
      contact_id: sd.contact_id ?? undefined,
      type: "signature_request",
      title: "Your tax return is ready to sign",
      body: "Your prepared tax return is ready for your signature in the portal.",
      link: "/portal/sign",
    })

    // 8. Advance the SD to "Sent for Signature" (skip_notify — see header).
    let advance: { success: boolean; to_stage?: string; error?: string } = { success: false }
    try {
      const adv = await advanceServiceDelivery({
        delivery_id: serviceDeliveryId,
        target_stage: "Sent for Signature",
        actor: "flow-send-for-signature",
        skip_notify: true,
        notes: "Tax return sent to client for e-signature",
      })
      advance = { success: adv.success, to_stage: adv.to_stage, error: adv.error }
    } catch (advErr) {
      advance = { success: false, error: advErr instanceof Error ? advErr.message : String(advErr) }
    }

    return NextResponse.json({
      success: true,
      token: result.token,
      client_url: result.clientUrl,
      preview_url: result.previewUrl,
      advance,
    })
  } catch (e) {
    console.error("[flow-send-for-signature] Error:", e)
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
