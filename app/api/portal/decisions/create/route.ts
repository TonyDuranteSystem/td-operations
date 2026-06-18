/**
 * POST /api/portal/decisions/create — staff creates a Client Decision Request.
 *
 * Staff-only (a Supabase user whose app_metadata.role !== 'client'). Reachable
 * from the CRM workspace. Validates type/options + notifies the client.
 *
 * Body: { service_delivery_id, contact_id, account_id?, request_type, title,
 *         message, message_it?, options?, auto_advance_on?, expires_at?,
 *         notify_on_response? }
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createDecisionRequest } from '@/lib/operations/decision-request'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const role = (user.app_metadata as Record<string, unknown> | undefined)?.role
  if (role === 'client') {
    return NextResponse.json({ success: false, error: 'Staff access required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const who = (user.user_metadata?.full_name as string | undefined)
    || (user.email as string | undefined)
    || 'staff'

  const result = await createDecisionRequest({
    service_delivery_id: body.service_delivery_id,
    contact_id: body.contact_id,
    account_id: body.account_id ?? null,
    request_type: body.request_type,
    title: body.title,
    message: body.message,
    message_it: body.message_it ?? null,
    options: body.options ?? {},
    auto_advance_on: body.auto_advance_on ?? null,
    expires_at: body.expires_at ?? null,
    notify_on_response: body.notify_on_response,
    created_by: who,
  })

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  }
  return NextResponse.json({ success: true, id: result.id })
}
