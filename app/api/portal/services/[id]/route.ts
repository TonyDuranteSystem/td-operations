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

  // Fetch service
  const { data: service } = await supabaseAdmin
    .from('services')
    .select('id, service_name, service_type, status, current_step, total_steps, blocked_waiting_external, blocked_reason, start_date, account_id')
    .eq('id', id)
    .single()

  if (!service) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Access control
  const accountIds = await getClientAccountIds(contactId)
  if (!accountIds.includes(service.account_id)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Fetch service delivery (has current stage + stage_history)
  // Linked by account_id + service_name (no FK between tables)
  const { data: delivery } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, stage, stage_order, stage_entered_at, stage_history, status, start_date, end_date, notes')
    .eq('account_id', service.account_id)
    .eq('service_name', service.service_name)
    .maybeSingle()

  // Fetch pipeline stages for this service type
  const { data: pipelineStages } = await supabaseAdmin
    .from('pipeline_stages')
    .select('stage_name, stage_order, stage_description')
    .eq('service_type', service.service_type)
    .order('stage_order')

  // Fetch documents linked to this account
  const { data: documents } = await supabaseAdmin
    .from('documents')
    .select('id, file_name, document_type_name, category, drive_file_id, created_at')
    .eq('account_id', service.account_id)
    .order('created_at', { ascending: false })
    .limit(20)

  // Build stage timeline
  const stageHistory = (delivery?.stage_history as Array<{ stage: string; entered_at: string; exited_at?: string }>) ?? []
  const currentStageOrder = delivery?.stage_order ?? 0

  const timeline = (pipelineStages ?? []).map(ps => {
    const historyEntry = stageHistory.find(h => h.stage === ps.stage_name)
    let stageStatus: 'completed' | 'current' | 'upcoming' = 'upcoming'
    if (ps.stage_order < currentStageOrder) stageStatus = 'completed'
    else if (ps.stage_order === currentStageOrder) stageStatus = 'current'

    return {
      name: ps.stage_name,
      order: ps.stage_order,
      description: ps.stage_description,
      status: stageStatus,
      entered_at: historyEntry?.entered_at ?? (stageStatus === 'current' ? delivery?.stage_entered_at : null),
      exited_at: historyEntry?.exited_at ?? null,
    }
  })

  return NextResponse.json({
    ...service,
    delivery: delivery ? {
      stage: delivery.stage,
      stage_order: delivery.stage_order,
      stage_entered_at: delivery.stage_entered_at,
      status: delivery.status,
      start_date: delivery.start_date,
      end_date: delivery.end_date,
      notes: delivery.notes,
    } : null,
    timeline,
    documents: documents ?? [],
  })
}
