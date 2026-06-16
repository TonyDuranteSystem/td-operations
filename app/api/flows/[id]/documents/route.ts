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
      .select('id, file_name, drive_link, mime_type, file_size, flow_stage, created_at')
      .eq('service_delivery_id', serviceDeliveryId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json(
        { success: false, error: `Could not load documents: ${error.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, documents: data ?? [] })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
