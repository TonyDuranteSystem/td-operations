/**
 * Fetch the latest tax-wizard submission for a flow (service_delivery). Backs
 * the flow Workspace data_viewer component (Tax Return review stages).
 *
 * Resolves the SD → account_id, then returns the newest tax_return_submissions
 * row for that account (by created_at). The DataViewer renders submitted_data
 * via the schema-agnostic grouping helper.
 *
 * GET → { success, submission: { entity_type, tax_year, review_status,
 *         created_at, submitted_data } | null }
 * [id] = service_delivery_id. Read-only.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id

    // 1. Resolve the SD → account_id.
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, account_id')
      .eq('id', serviceDeliveryId)
      .single()

    if (sdErr || !sd) {
      return NextResponse.json(
        { success: false, error: 'Flow (service delivery) not found' },
        { status: 404 },
      )
    }
    if (!sd.account_id) {
      // Contact-only SDs have no account-scoped submission to show.
      return NextResponse.json({ success: true, submission: null })
    }

    // 2. Latest submission for the account (newest first).
    const { data, error } = await supabaseAdmin
      .from('tax_return_submissions')
      .select('entity_type, tax_year, review_status, created_at, submitted_data')
      .eq('account_id', sd.account_id)
      .order('created_at', { ascending: false })
      .limit(1)

    if (error) {
      return NextResponse.json(
        { success: false, error: `Could not load submission: ${error.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, submission: data?.[0] ?? null })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
