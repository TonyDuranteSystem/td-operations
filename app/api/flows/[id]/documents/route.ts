/**
 * List documents bound to a flow (service_delivery). Backs the flow Workspace
 * document_viewer component.
 *
 * GET → { success, documents: [{ id, file_name, drive_link, mime_type,
 *         file_size, flow_stage, created_at }] }
 * [id] = service_delivery_id.
 *
 * Read-only. Returns the SD's documents newest-first.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// service_delivery_id / flow_stage were added by the S0 migration but the
// generated DB types aren't regenerated yet — query via an untyped surface
// (mirrors the upload-document route and the flow Workspace page).
type UntypedSelect = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>
      }
    }
  }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id
    const adminUntyped = supabaseAdmin as unknown as UntypedSelect

    const { data, error } = await adminUntyped
      .from('documents')
      .select('id, file_name, drive_link, drive_file_id, mime_type, file_size, flow_stage, created_at')
      .eq('service_delivery_id', serviceDeliveryId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json(
        { success: false, error: `Could not load documents: ${error.message}` },
        { status: 500 },
      )
    }

    // Resolve a viewable link for each document.
    //
    // Bug (2026-06-26, Luca): autoSaveDocument (ITIN W-7/1040-NR/Schedule OI,
    // signed OA/lease/contract) writes `drive_file_id` but NEVER `drive_link`,
    // so the workspace document-viewer — which only renders a clickable "View"
    // when `drive_link` is set — showed a non-clickable "No link" for every ITIN
    // doc. Confirmed against prod: all ITIN docs have drive_file_id set,
    // drive_link NULL. Fix here (not a backfill) repairs existing + future docs:
    // when the stored drive_link is empty but a drive_file_id exists, fall back
    // to the service-account-backed `/api/documents/[id]/preview` streamer
    // (handles BOTH Drive ids and `storage:<path>` ids, no Google login needed).
    // We only fall back when drive_link is empty so working signed-storage URLs
    // (flow uploads) are preserved.
    const documents = (data ?? []).map((d) => {
      const driveLink = (d.drive_link as string | null) || null
      const driveFileId = (d.drive_file_id as string | null) || null
      return {
        id: d.id,
        file_name: d.file_name,
        drive_link: driveLink ?? (driveFileId ? `/api/documents/${d.id as string}/preview` : null),
        mime_type: d.mime_type,
        file_size: d.file_size,
        flow_stage: d.flow_stage,
        created_at: d.created_at,
      }
    })

    // Explicit no-store so neither the browser nor any CDN caches the doc list —
    // defense-in-depth alongside the client cache:'no-store' and the admin
    // client's uncached fetch (the "documents not showing on sandbox" bug).
    return NextResponse.json(
      { success: true, documents },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
