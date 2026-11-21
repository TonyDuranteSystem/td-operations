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
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability } from '@/lib/portal/team/capabilities'
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

    // A team login may ask for a service only when the owner ticked "Can ask for new services". Its request is filed under ITS
    // company (a team login has no person of its own), with the colleague's name, never the hidden placeholder address.
    let teamAccountId: string | null = null
    let teamName: string | null = null
    if ((user.app_metadata as Record<string, unknown> | undefined)?.kind === 'team_member') {
      const identity = await resolvePortalIdentity(user)
      if (identity.kind !== 'teammate' || !hasCapability(identity.capabilities, 'request_services')) {
        return NextResponse.json({ error: 'Your team login cannot ask for new services. Ask the company owner.' }, { status: 403 })
      }
      teamAccountId = identity.accountId
      teamName = identity.displayName
    }

    const contactId = getClientContactId(user)
    const body = await req.json()
    const { service_id, details, urgency } = body

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

    // Find account linked to this contact. ALWAYS the signed-in person's own contact: the screens send their own id, and a
    // contact_id named in the request used to be trusted, so anyone could file a request under someone else's name.
    const targetContactId = contactId
    let accountId: string | undefined
    let companyName: string | undefined

    if (teamAccountId) {
      const { data: acct } = await supabaseAdmin.from('accounts').select('company_name').eq('id', teamAccountId).maybeSingle()
      accountId = teamAccountId
      companyName = (acct as { company_name: string | null } | null)?.company_name ?? undefined
    } else if (targetContactId) {
      const { data: links } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id, accounts(company_name)')
        .is('access_revoked_at', null)
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

    const clientName = teamName ? `${teamName} (team member)` : (contact?.full_name || user.user_metadata?.full_name || user.email || 'Unknown')

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
        description: `Service requested via Client Portal.\n\nClient: ${clientName}${companyName ? `\nCompany: ${companyName}` : ''}\n${teamName ? '' : `Email: ${contact?.email || user.email}`}\n\nDetails:\n${details}`,
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
