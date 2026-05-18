import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { createSD } from '@/lib/operations/service-delivery'
import { createTDInvoice } from '@/lib/portal/td-invoice'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Auto-invoice helper (2026-05-18). After createSD succeeds, look up the
 * service in service_catalog. If it has a default_price > 0, create a TD
 * invoice (draft in DB; client sees it in portal TD Billing per R092).
 *
 * Fire-and-forget: any failure here MUST NOT roll back the SD. The SD is
 * the primary entity; the invoice is a convenience. Returns the result so
 * the caller can surface a toast warning when invoice creation failed.
 *
 * Idempotency: keyed on the SD id so retries don't create duplicate invoices.
 */
async function createAutoInvoiceForSD(args: {
  sdId: string
  serviceType: string
  serviceName: string
  accountId: string | null
  contactId: string | null
}): Promise<{ ok: true; invoiceNumber: string; total: number } | { ok: false; reason: string }> {
  try {
    const { data: catalogRow } = await supabaseAdmin
      .from('service_catalog')
      .select('default_price, default_currency, name')
      .eq('pipeline', args.serviceType)
      .eq('active', true)
      .maybeSingle()
    if (!catalogRow) {
      return { ok: false, reason: `No service_catalog row for service_type='${args.serviceType}'` }
    }
    const price = typeof catalogRow.default_price === 'number' ? catalogRow.default_price : null
    if (price === null || price <= 0) {
      return { ok: false, reason: `service '${catalogRow.name}' has no default_price set` }
    }
    if (!args.accountId && !args.contactId) {
      return { ok: false, reason: 'no account_id or contact_id on SD' }
    }

    const currency = (catalogRow.default_currency === 'EUR' ? 'EUR' : 'USD') as 'USD' | 'EUR'
    const result = await createTDInvoice({
      account_id: args.accountId ?? undefined,
      contact_id: args.contactId ?? undefined,
      line_items: [
        {
          description: `${catalogRow.name} — ${args.serviceName}`,
          unit_price: price,
          quantity: 1,
        },
      ],
      currency,
      idempotency_key: `add-service:${args.sdId}`,
    })
    return { ok: true, invoiceNumber: result.invoiceNumber, total: result.total }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * POST /api/crm/admin-actions/create-service
 * Create a service delivery for an account.
 *
 * Routes through lib/operations/service-delivery.createSD so the stage is
 * resolved from pipeline_stages (not hardcoded "Data Collection" which is
 * only valid for a few service_types — see dev_task 6d2a2be1).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { account_id, contact_id, service_type, notes } = body

  if (!service_type) {
    return NextResponse.json({ error: 'service_type is required' }, { status: 400 })
  }
  if (!account_id && !contact_id) {
    return NextResponse.json({ error: 'account_id or contact_id is required' }, { status: 400 })
  }

  // Get account name for service_name
  let serviceName = service_type
  if (account_id) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', account_id)
      .single()
    if (account) serviceName = `${service_type} — ${account.company_name}`
  }

  try {
    const data = await createSD({
      service_type,
      service_name: serviceName,
      account_id: account_id || null,
      contact_id: contact_id || null,
      notes: notes || undefined,
    })

    // Auto-create the TD invoice (per Antonio 2026-05-18). Fire-and-forget —
    // SD remains canonical; invoice is convenience. Client sees the invoice
    // in their portal TD Billing section (R092 — no email with pay link).
    const invoice = await createAutoInvoiceForSD({
      sdId: data.id,
      serviceType: service_type,
      serviceName,
      accountId: data.account_id ?? null,
      contactId: data.contact_id ?? null,
    })

    return NextResponse.json({ success: true, data, invoice })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
