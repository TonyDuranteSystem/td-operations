/**
 * Upload a document bound to a flow (service_delivery) + the stage that expects
 * it, then AUTO-ADVANCE the service delivery to the next stage.
 *
 * Mirrors the DBA upload route (app/api/accounts/[id]/dba/[dbaId]/
 * upload-document) but stamps service_delivery_id + flow_stage on the documents
 * row so the flow Workspace's Documents tab can group it.
 *
 * Flow:
 *  1. Download the file from Supabase Storage (onboarding-uploads bucket).
 *  2. Upload to the account's Drive folder.
 *  3. Insert a documents row stamped with service_delivery_id + flow_stage.
 *  4. Audit to action_log (scoped with service_delivery_id).
 *  5. Auto-advance the SD to the next stage via advanceServiceDelivery.
 *     NOTE: the +1-year renewal-date bump for State RA Renewal / State Annual
 *     Report is handled INSIDE advanceServiceDelivery on the transition into the
 *     final (Closed) stage. We deliberately do NOT bump the date here — doing so
 *     would double-bump it (+2 years). advanceServiceDelivery is the single
 *     source of truth for that side effect.
 *  6. Best-effort cleanup of the storage file.
 *
 * Body: { storage_path, file_name, mime_type?, flow_stage? }
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { advanceServiceDelivery } from '@/lib/service-delivery'

// Untyped insert surface: service_delivery_id / flow_stage were added by the S0
// migration but the generated DB types haven't been regenerated yet.
type UntypedInsert = {
  from: (table: string) => { insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }> }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const adminUntyped = supabaseAdmin as unknown as UntypedInsert
    const serviceDeliveryId = params.id
    const body = await req.json().catch(() => ({}))
    const storagePath: string | undefined = body.storage_path
    const fileName: string | undefined = body.file_name
    const mimeType: string | undefined = body.mime_type
    const flowStageInput: string | null = typeof body.flow_stage === 'string' ? body.flow_stage : null
    // Staff-confirmed formation (filing) date — sent when uploading the Articles
    // of Organization on a Company Formation flow. The upload auto-advances into
    // "Articles Received", which MATERIALIZES the company; without this the
    // materializer defaults formation_date to today (the processing day) and the
    // SS-4 prints the wrong date. ISO YYYY-MM-DD only.
    const formationDate: string | undefined =
      typeof body.formation_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.formation_date)
        ? body.formation_date
        : undefined
    // Default true: every existing upload stage auto-advances. A caller can opt
    // out (auto_advance:false) when a separate action owns the advance — e.g. the
    // Tax Return "Tax Return Prepared" stage, where "Send for Signature" advances.
    const autoAdvance: boolean = body.auto_advance !== false

    if (!storagePath || !fileName) {
      return NextResponse.json(
        { success: false, detail: 'Missing storage_path or file_name' },
        { status: 400 },
      )
    }

    // 1. Resolve the SD → account/contact + current stage (fallback for flow_stage).
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, account_id, contact_id, stage, service_type')
      .eq('id', serviceDeliveryId)
      .single()

    if (sdErr || !sd) {
      return NextResponse.json(
        { success: false, detail: 'Flow (service delivery) not found' },
        { status: 404 },
      )
    }
    // Contact-scoped flows have account_id = NULL — e.g. an in-flight Company
    // Formation before the company is materialized (the account is created at
    // "Articles Received"). That is VALID, not "not found"; we just have no Drive
    // folder to target, so the storage fallback below handles it.
    const accountId = (sd.account_id as string | null) ?? null
    const contactId = (sd.contact_id as string | null) ?? null
    const flowStage = flowStageInput ?? (sd.stage as string | null) ?? null

    // ITIN approval letter (CP565) uploaded at the terminal "ITIN Approved"
    // stage → after filing, OCR it, stamp the contact's ITIN fields, notify
    // the client, and complete the flow (lib/itin/finalize-approval.ts).
    // Also the one flow upload that is client-visible from birth: the letter
    // IS the client's deliverable.
    const isItinApprovalUpload = sd.service_type === 'ITIN' && flowStage === 'ITIN Approved'

    // 2. Download from Storage.
    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from('onboarding-uploads')
      .download(storagePath)

    if (dlErr || !blob) {
      return NextResponse.json(
        { success: false, detail: `Storage download failed: ${dlErr?.message || 'no data'}` },
        { status: 500 },
      )
    }

    const rawContent = await blob.arrayBuffer()
    const buffer = Buffer.from(rawContent)
    const fileMime = mimeType || blob.type || 'application/pdf'

    // 3. Decide where the canonical copy lives.
    //    Production: copy to the account's Google Drive folder (canonical store).
    //    Sandbox (SANDBOX_MODE=1): Drive writes are mocked AND many seeded
    //    accounts have no Drive folder, so we KEEP the file in Supabase Storage
    //    (onboarding-uploads) and reference it directly — no Drive round-trip and
    //    no Drive-folder requirement. The documents row + stage advance happen
    //    identically, so the flow works end-to-end in sandbox.
    // Storage fallback when there's no Drive target: sandbox (mocked Drive) OR a
    // contact-scoped SD with no account yet (in-flight formation — no Drive folder).
    const useStorageFallback = process.env.SANDBOX_MODE === '1' || !accountId

    let docFileId: string
    let docLink: string

    if (useStorageFallback) {
      // The file already lives in onboarding-uploads from the signed-URL PUT —
      // keep it (do NOT delete it in step 8). Synthetic, per-upload-unique
      // drive_file_id (the column is NOT NULL) that doubles as the idempotency
      // key, so repeat uploads create distinct rows instead of colliding on a
      // shared mock id.
      docFileId = `storage:${storagePath}`
      const { data: signed } = await supabaseAdmin.storage
        .from('onboarding-uploads')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365) // 1 year
      docLink = signed?.signedUrl ?? `onboarding-uploads/${storagePath}`
    } else {
      // Production: resolve the account's Drive folder and copy the file there.
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('drive_folder_id, gdrive_folder_url')
        .eq('id', accountId)
        .single()

      let driveFolderId: string | null = (account?.drive_folder_id as string | null) ?? null
      if (!driveFolderId && account?.gdrive_folder_url) {
        const match = (account.gdrive_folder_url as string).match(/folders\/([a-zA-Z0-9_-]+)/)
        if (match) driveFolderId = match[1]
      }
      if (!driveFolderId) {
        return NextResponse.json(
          { success: false, detail: 'Account has no Drive folder. Create or link one first.' },
          { status: 400 },
        )
      }

      const { uploadBinaryToDrive } = await import('@/lib/google-drive')
      const driveFile = (await uploadBinaryToDrive(fileName, buffer, fileMime, driveFolderId)) as {
        id: string
        name: string
      }
      docFileId = driveFile.id
      docLink = `https://drive.google.com/file/d/${driveFile.id}/view`
    }

    // 5. Insert documents row (idempotent on drive_file_id), stamped with the flow.
    const { data: existingDoc } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('drive_file_id', docFileId)
      .limit(1)

    if (!existingDoc?.length) {
      await adminUntyped.from('documents').insert({
        file_name: fileName,
        drive_file_id: docFileId,
        drive_link: docLink,
        mime_type: fileMime,
        file_size: buffer.length,
        status: 'classified',
        account_id: accountId,
        contact_id: contactId,
        service_delivery_id: serviceDeliveryId,
        flow_stage: flowStage,
        portal_visible: isItinApprovalUpload,
      })
    }

    // 6. Audit log, scoped to the flow.
    await adminUntyped.from('action_log').insert({
      actor: 'crm-admin',
      action_type: 'upload_flow_document',
      table_name: 'documents',
      record_id: docFileId,
      account_id: accountId ?? undefined,
      service_delivery_id: serviceDeliveryId,
      summary: `Flow document uploaded: ${fileName}`,
      details: { file_name: fileName, service_delivery_id: serviceDeliveryId, flow_stage: flowStage },
    })

    // 6b. ITIN approval letter: OCR → stamp contact ITIN fields → notify the
    // client → complete the flow. Best-effort by design — the letter is
    // already filed; failures surface as staff-facing warnings in `detail`.
    let itinFinalize: import('@/lib/itin/finalize-approval').ItinFinalizeResult | null = null
    if (isItinApprovalUpload && contactId) {
      const { finalizeItinApproval } = await import('@/lib/itin/finalize-approval')
      itinFinalize = await finalizeItinApproval({
        serviceDeliveryId,
        contactId,
        fileName,
        content: rawContent,
        mimeType: fileMime,
      })
    } else if (isItinApprovalUpload && !contactId) {
      itinFinalize = {
        attempted: false,
        finalized: false,
        warnings: ['Flow has no contact linked — ITIN not extracted. Link a contact, then enter the ITIN manually.'],
      }
    }

    // 7. Auto-advance the SD to the next stage. advanceServiceDelivery owns all
    // stage-advance side effects (stage_history, auto-tasks, portal notify, and
    // the +1-year renewal-date bump for RA Renewal / Annual Report on the
    // transition into the final stage). We do NOT bump the date here — that
    // would double it. Best-effort: a failed/at-final advance must NOT fail the
    // upload that already succeeded.
    let advance: { success: boolean; to_stage?: string; is_completed?: boolean; error?: string } = {
      success: false,
    }
    // isItinApprovalUpload: "ITIN Approved" is terminal — the finalize step
    // (6b) owns completion; there is no next stage to advance to.
    if (autoAdvance && !isItinApprovalUpload) {
      try {
        const result = await advanceServiceDelivery({
          delivery_id: serviceDeliveryId,
          formation_date: formationDate,
          actor: 'flow-upload',
          notes: `Document uploaded: ${fileName}`,
        })
        advance = {
          success: result.success,
          to_stage: result.to_stage,
          is_completed: result.is_completed,
          error: result.error,
        }
      } catch (advErr) {
        // "Already at final stage" / intake-stage guard / approval-required all land
        // here. The upload is still a success; surface the advance outcome only.
        advance = { success: false, error: advErr instanceof Error ? advErr.message : String(advErr) }
      }
    }

    // 8. Best-effort storage cleanup — only when the canonical copy now lives in
    //    Drive. In the storage-fallback path the Storage object IS the document,
    //    so it must be kept.
    if (!useStorageFallback) {
      supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {})
    }

    // Staff-facing summary: what the ITIN finalize actually did (or why not).
    let detail = `${fileName} uploaded`
    if (itinFinalize) {
      if (itinFinalize.finalized) {
        detail += ` — ITIN ${itinFinalize.itin_number} saved to the contact (issued ${itinFinalize.itin_issue_date}), client notified, flow completed.`
      }
      if (itinFinalize.warnings.length) {
        detail += ` — ⚠️ ${itinFinalize.warnings.join(' ')}`
      }
    }

    return NextResponse.json({
      success: true,
      detail,
      driveFileId: docFileId,
      advance,
      itin_finalize: itinFinalize,
    })
  } catch (e) {
    console.error('[flow-upload-document] Error:', e)
    return NextResponse.json(
      { success: false, detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
