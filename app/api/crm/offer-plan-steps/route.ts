import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isStaffUser } from '@/lib/auth'
import { stepOptionsForServices, STEP_TRIGGER_SERVICE_TYPES, type StepOption } from '@/lib/plan-invoices/steps'

/**
 * GET /api/crm/offer-plan-steps?services=Company Formation,ITIN
 *
 * The steps the offer builder offers for "When a step is reached" (dev job ae3c19db) — for the services bought in THIS offer, only
 * the ones whose job is tied to its offer (lib/plan-invoices/steps.ts), in step order, straight from the step settings. Staff only,
 * read-only. Under /api/crm on purpose: /api/offers is a public prefix.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const wanted = (request.nextUrl.searchParams.get('services') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 80)
    .slice(0, 20)
  if (wanted.length === 0) return NextResponse.json({ steps: [] })

  const { data, error } = await supabaseAdmin
    .from('pipeline_stages')
    .select('service_type, stage_name, stage_order')
    .in('service_type', STEP_TRIGGER_SERVICE_TYPES as unknown as string[])
  if (error) return NextResponse.json({ error: `The step list could not be read: ${error.message}` }, { status: 500 })
  const all: StepOption[] = (data ?? [])
    .filter((r): r is { service_type: string; stage_name: string; stage_order: number } => !!r.service_type && !!r.stage_name && typeof r.stage_order === 'number')
  return NextResponse.json({ steps: stepOptionsForServices(all, wanted) })
}
