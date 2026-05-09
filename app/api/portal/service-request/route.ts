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
import { getServiceBySlug, type ServiceSlug } from '@/lib/services'

export const dynamic = 'force-dynamic'

// CRM category routing for portal service requests. Keyed by canonical
// catalog slug. Anything not in this map falls back to 'Client Response'.
// Not all ServiceSlugs route here (the picker only offers nine); the
// `Partial` type lets the compiler accept that.
const SERVICE_CATEGORIES: Partial<Record<ServiceSlug, string>> = {
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
    const { service_id, details, urgency, contact_id } = body

    if (!service_id || !details) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Validate service_id against the catalog. The display label used in the
    // task title comes from the catalog (the trusted source) — not from any
    // client-supplied service_name field.
    const serviceEntry = await getServiceBySlug(service_id)
    if (!serviceEntry) {
      return NextResponse.json(
        { error: `Unknown service: ${service_id}` },
        { status: 400 },
      )
    }
    const serviceName = serviceEntry.display_name

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
      ? `${serviceName} — ${companyName} (portal request)`
      : `${serviceName} — ${clientName} (portal request)`

    /* eslint-disable no-restricted-syntax */
    // Pre-existing raw insert; predates the P2.4 rule. Extracting a
    // createTask() helper into lib/operations/task.ts is tracked
    // separately and out of scope for catalog Phase 3.
    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .insert({
        task_title: taskTitle,
        description: `Service requested via Client Portal.\n\nClient: ${clientName}${companyName ? `\nCompany: ${companyName}` : ''}\nEmail: ${contact?.email || user.email}\n\nDetails:\n${details}`,
        status: 'To Do',
        priority: urgency === 'urgent' ? 'Urgent' : 'Normal',
        category: (SERVICE_CATEGORIES[service_id as ServiceSlug] || 'Client Response') as never,
        assigned_to: 'Antonio',
        account_id: accountId || null,
        contact_id: targetContactId || null,
      })
      .select('id')
      .single()
    /* eslint-enable no-restricted-syntax */

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
