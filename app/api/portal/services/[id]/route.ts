import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/services/[id] — Get service detail with pipeline stages + timeline
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact' }, { status: 403 })

  const accountIds = await getClientAccountIds(contactId)

  // Try service_deliveries first (new table, IDs come from here)
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, service_type, stage, stage_order, stage_entered_at, stage_history, status, start_date, end_date, notes, account_id')
    .eq('id', id)
    .maybeSingle()

  let accountId: string
  let serviceBase: {
    id: string; service_name: string; service_type: string; status: string
    current_step: number | null; total_steps: number | null
    blocked_waiting_external: boolean | null; blocked_reason: string | null
    start_date: string | null
  }
  let delivery: { stage: string; stage_order: number; stage_entered_at: string | null; status: string; start_date: string | null; end_date: string | null; notes: string | null } | null = null

  if (sd) {
    // Access control
    if (!accountIds.includes(sd.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    accountId = sd.account_id
    serviceBase = {
      id: sd.id,
      service_name: sd.service_name ?? sd.service_type ?? 'Service',
      service_type: sd.service_type ?? '',
      status: sd.status === 'active' ? 'In Progress' : 'Completed',
      current_step: null,
      total_steps: null,
      blocked_waiting_external: false,
      blocked_reason: null,
      start_date: sd.start_date,
    }
    delivery = {
      stage: sd.stage,
      stage_order: sd.stage_order,
      stage_entered_at: sd.stage_entered_at,
      status: sd.status,
      start_date: sd.start_date,
      end_date: sd.end_date,
      notes: sd.notes,
    }
  } else {
    // Fallback: legacy services table
    const { data: service } = await supabaseAdmin
      .from('services')
      .select('id, service_name, service_type, status, current_step, total_steps, blocked_waiting_external, blocked_reason, start_date, account_id')
      .eq('id', id)
      .single()

    if (!service) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!accountIds.includes(service.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    accountId = service.account_id
    serviceBase = service

    // Get delivery linked by account_id + service_name
    const { data: legacyDelivery } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, stage, stage_order, stage_entered_at, stage_history, status, start_date, end_date, notes')
      .eq('account_id', accountId)
      .eq('service_name', service.service_name)
      .maybeSingle()

    if (legacyDelivery) {
      delivery = {
        stage: legacyDelivery.stage,
        stage_order: legacyDelivery.stage_order,
        stage_entered_at: legacyDelivery.stage_entered_at,
        status: legacyDelivery.status,
        start_date: legacyDelivery.start_date,
        end_date: legacyDelivery.end_date,
        notes: legacyDelivery.notes,
      }
    }
  }

  const sdForHistory = sd ?? (delivery ? { stage_history: null, stage_order: delivery.stage_order, stage_entered_at: delivery.stage_entered_at } : null)

  // Fetch pipeline stages for this service type
  const { data: pipelineStages } = await supabaseAdmin
    .from('pipeline_stages')
    .select('stage_name, stage_order, stage_description, client_description')
    .eq('service_type', serviceBase.service_type)
    .order('stage_order')

  // Fetch documents linked to this account
  const { data: documents } = await supabaseAdmin
    .from('documents')
    .select('id, file_name, document_type_name, category, drive_file_id, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(20)

  // Build stage timeline
  const stageHistory = (sdForHistory?.stage_history as Array<{ stage: string; entered_at: string; exited_at?: string }> | null) ?? []
  const currentStageOrder = sdForHistory?.stage_order ?? 0

  const timeline = (pipelineStages ?? []).map(ps => {
    const historyEntry = stageHistory.find(h => h.stage === ps.stage_name)
    let stageStatus: 'completed' | 'current' | 'upcoming' = 'upcoming'
    if (ps.stage_order < currentStageOrder) stageStatus = 'completed'
    else if (ps.stage_order === currentStageOrder) stageStatus = 'current'

    return {
      name: ps.stage_name,
      order: ps.stage_order,
      description: ps.client_description || ps.stage_description,
      status: stageStatus,
      entered_at: historyEntry?.entered_at ?? (stageStatus === 'current' ? sdForHistory?.stage_entered_at : null),
      exited_at: historyEntry?.exited_at ?? null,
    }
  })

  return NextResponse.json({
    ...serviceBase,
    delivery,
    timeline,
    documents: documents ?? [],
  })
}
