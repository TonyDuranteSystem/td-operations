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

    // 3. Resolve the account's Drive folder.
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

    // 4. Upload to Drive.
    const { uploadBinaryToDrive } = await import('@/lib/google-drive')
    const driveFile = (await uploadBinaryToDrive(fileName, buffer, fileMime, driveFolderId)) as {
      id: string
      name: string
    }

    // 5. Insert documents row (idempotent on drive_file_id), stamped with the flow.
    const { data: existingDoc } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('drive_file_id', driveFile.id)
      .limit(1)

    if (!existingDoc?.length) {
      await adminUntyped.from('documents').insert({
        file_name: fileName,
        drive_file_id: driveFile.id,
        drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
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
      record_id: driveFile.id,
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

    // 8. Best-effort storage cleanup.
    supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {})

    return NextResponse.json({
      success: true,
      detail: `${fileName} uploaded`,
      driveFileId: driveFile.id,
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
