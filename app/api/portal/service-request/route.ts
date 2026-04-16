/**
 * POST /api/portal/service-request
 *
 * Creates a CRM task from a portal service request.
 * Called when a client requests a new service from the portal.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'
import { getClientContactId } from '@/lib/portal-auth'

export const dynamic = 'force-dynamic'

const SERVICE_CATEGORIES: Record<string, string> = {
  llc_formation: 'Formation',
  tax_return: 'Filing',
  itin: 'Filing',
  banking: 'KYC',
  ein: 'Filing',
  shipping: 'Shipping',
  notary: 'Notarization',
  closure: 'Filing',
  consulting: 'Client Communication',
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isClient(user)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const contactId = getClientContactId(user)
    const body = await req.json()
    const { service_id, service_name, details, urgency, contact_id } = body

    if (!service_id || !service_name || !details) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Find account linked to this contact
    const targetContactId = contact_id || contactId
    let accountId: string | undefined
    let companyName: string | undefined

    if (targetContactId) {
      const { data: links } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id, accounts(company_name)')
        .eq('contact_id', targetContactId)
        .limit(1)

      if (links?.[0]) {
        accountId = links[0].account_id
        companyName = (links[0] as unknown as { accounts: { company_name: string } }).accounts?.company_name
      }
    }

    // Get contact name
    const { data: contact } = targetContactId
      ? await supabaseAdmin.from('contacts').select('full_name, email').eq('id', targetContactId).single()
      : { data: null }

    const clientName = contact?.full_name || user.user_metadata?.full_name || user.email || 'Unknown'

    // Create CRM task
    const taskTitle = companyName
      ? `${service_name} — ${companyName} (portal request)`
      : `${service_name} — ${clientName} (portal request)`

    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .insert({
        task_title: taskTitle,
        description: `Service requested via Client Portal.\n\nClient: ${clientName}${companyName ? `\nCompany: ${companyName}` : ''}\nEmail: ${contact?.email || user.email}\n\nDetails:\n${details}`,
        status: 'To Do',
        priority: urgency === 'urgent' ? 'Urgent' : 'Normal',
        category: (SERVICE_CATEGORIES[service_id] || 'Client Response') as never,
        assigned_to: 'Antonio',
        account_id: accountId || null,
        contact_id: targetContactId || null,
      })
      .select('id')
      .single()

    if (taskErr) {
      console.error('[service-request] Task creation failed:', taskErr.message)
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      task_id: task?.id,
      message: 'Service request submitted',
    })
  } catch (err) {
    console.error('[service-request] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
