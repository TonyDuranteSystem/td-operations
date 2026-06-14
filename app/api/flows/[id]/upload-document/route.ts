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

    if (!storagePath || !fileName) {
      return NextResponse.json(
        { success: false, detail: 'Missing storage_path or file_name' },
        { status: 400 },
      )
    }

    // 1. Resolve the SD → account + current stage (fallback for flow_stage).
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, account_id, stage')
      .eq('id', serviceDeliveryId)
      .single()

    if (sdErr || !sd || !sd.account_id) {
      return NextResponse.json(
        { success: false, detail: 'Flow (service delivery) not found' },
        { status: 404 },
      )
    }
    const accountId = sd.account_id as string
    const flowStage = flowStageInput ?? (sd.stage as string | null) ?? null

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

    const buffer = Buffer.from(await blob.arrayBuffer())
    const fileMime = mimeType || blob.type || 'application/pdf'

    // 3. Decide where the canonical copy lives.
    //    Production: copy to the account's Google Drive folder (canonical store).
    //    Sandbox (SANDBOX_MODE=1): Drive writes are mocked AND many seeded
    //    accounts have no Drive folder, so we KEEP the file in Supabase Storage
    //    (onboarding-uploads) and reference it directly — no Drive round-trip and
    //    no Drive-folder requirement. The documents row + stage advance happen
    //    identically, so the flow works end-to-end in sandbox.
    const useStorageFallback = process.env.SANDBOX_MODE === '1'

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
        service_delivery_id: serviceDeliveryId,
        flow_stage: flowStage,
        portal_visible: false,
      })
    }

    // 6. Audit log, scoped to the flow.
    await adminUntyped.from('action_log').insert({
      actor: 'crm-admin',
      action_type: 'upload_flow_document',
      table_name: 'documents',
      record_id: docFileId,
      account_id: accountId,
      service_delivery_id: serviceDeliveryId,
      summary: `Flow document uploaded: ${fileName}`,
      details: { file_name: fileName, service_delivery_id: serviceDeliveryId, flow_stage: flowStage },
    })

    // 7. Auto-advance the SD to the next stage. advanceServiceDelivery owns all
    // stage-advance side effects (stage_history, auto-tasks, portal notify, and
    // the +1-year renewal-date bump for RA Renewal / Annual Report on the
    // transition into the final stage). We do NOT bump the date here — that
    // would double it. Best-effort: a failed/at-final advance must NOT fail the
    // upload that already succeeded.
    let advance: { success: boolean; to_stage?: string; is_completed?: boolean; error?: string } = {
      success: false,
    }
    try {
      const result = await advanceServiceDelivery({
        delivery_id: serviceDeliveryId,
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

    // 8. Best-effort storage cleanup — only when the canonical copy now lives in
    //    Drive. In the storage-fallback path the Storage object IS the document,
    //    so it must be kept.
    if (!useStorageFallback) {
      supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {})
    }

    return NextResponse.json({
      success: true,
      detail: `${fileName} uploaded`,
      driveFileId: docFileId,
      advance,
    })
  } catch (e) {
    console.error('[flow-upload-document] Error:', e)
    return NextResponse.json(
      { success: false, detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
