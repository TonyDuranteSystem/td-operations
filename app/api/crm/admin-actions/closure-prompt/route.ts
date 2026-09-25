import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { promptClientForClosureForm } from '@/lib/portal/closure-client-prompt'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/crm/admin-actions/closure-prompt
 * Body: { service_delivery_id, force? }
 *
 * "Send anyway" for a closure-form prompt that was HELD because the client
 * already sent an older closure form (see lib/portal/closure-client-prompt.ts).
 * Separate from create-service so re-sending never creates a second service.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await request.json().catch(() => ({}))
  const sdId = typeof body.service_delivery_id === 'string' ? body.service_delivery_id : ''
  if (!sdId) {
    return NextResponse.json({ error: 'service_delivery_id is required' }, { status: 400 })
  }
  const outcome = await promptClientForClosureForm({ serviceDeliveryId: sdId, force: body.force === true })
  return NextResponse.json({ success: true, client_prompt: outcome })
}
