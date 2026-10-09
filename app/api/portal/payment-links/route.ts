import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import type { User } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { validatePaymentLinkUrl, pickNewDefault, GATEWAYS, CURRENCIES } from '@/lib/portal/payment-link-rules'

// Default-deny (contacts AND teammates; never skipped). Payment links live under
// the 'invoices_billing' capability.
function verifyAccess(user: User, accountId: string) {
  return canAccessAccount(user, accountId, 'invoices_billing')
}

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = new URL(request.url).searchParams.get('account_id')
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  if (!await verifyAccess(user, accountId)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const { data } = await supabaseAdmin
    .from('payment_links')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at')

  return NextResponse.json(data ?? [])
}

/**
 * Make ONE link the default for the company: set the new one FIRST, then clear the others. Done in that order the
 * company is never left with no default (a window with two is harmless; the readers take the oldest default).
 */
async function makeDefault(accountId: string, linkId: string) {
  const { error } = await supabaseAdmin.from('payment_links').update({ is_default: true }).eq('id', linkId).eq('account_id', accountId)
  if (error) throw new Error(error.message)
  const { error: clearErr } = await supabaseAdmin.from('payment_links').update({ is_default: false }).eq('account_id', accountId).neq('id', linkId)
  if (clearErr) throw new Error(clearErr.message)
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { account_id, label, url, gateway, amount, currency, is_default } = body

  if (!account_id || !label || !url) return NextResponse.json({ error: 'label, url, account_id required' }, { status: 400 })
  if (!await verifyAccess(user, account_id)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const checked = validatePaymentLinkUrl(url)
  if ('error' in checked) return NextResponse.json({ error: checked.error }, { status: 400 })
  const cleanLabel = String(label).trim().slice(0, 100)
  if (!cleanLabel) return NextResponse.json({ error: 'The label cannot be empty.' }, { status: 400 })
  const cleanGateway = (GATEWAYS as readonly string[]).includes(gateway) ? gateway : 'other'
  const cleanCurrency = (CURRENCIES as readonly string[]).includes(currency) ? currency : 'USD'
  const cleanAmount = amount === null || amount === undefined || amount === '' ? null : Number(amount)
  if (cleanAmount !== null && (!Number.isFinite(cleanAmount) || cleanAmount < 0)) {
    return NextResponse.json({ error: 'The amount must be a positive number.' }, { status: 400 })
  }

  const { count } = await supabaseAdmin.from('payment_links').select('id', { count: 'exact', head: true }).eq('account_id', account_id)
  const makeIt = !!is_default || (count ?? 0) === 0

  // Inserted as a normal link; the default switch happens afterwards in the safe order.
  const { data, error } = await supabaseAdmin
    .from('payment_links')
    .insert({ account_id, label: cleanLabel, url: checked.url, gateway: cleanGateway, amount: cleanAmount, currency: cleanCurrency, is_default: false })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (makeIt) {
    try { await makeDefault(account_id, data.id) } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not set the default link.' }, { status: 500 })
    }
    return NextResponse.json({ ...data, is_default: true })
  }
  return NextResponse.json(data)
}

export async function PATCH(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { id, account_id, is_default } = body

  if (!id || !account_id) return NextResponse.json({ error: 'id and account_id required' }, { status: 400 })
  if (!await verifyAccess(user, account_id)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  if (is_default) {
    // The link must be THIS company's. Checked BEFORE anything is cleared, so a wrong id can never leave the
    // company without a default, and one company can never promote another company's link.
    const { data: link } = await supabaseAdmin.from('payment_links').select('id').eq('id', id).eq('account_id', account_id).maybeSingle()
    if (!link) return NextResponse.json({ error: 'Payment link not found' }, { status: 404 })
    try { await makeDefault(account_id, id) } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not set the default link.' }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const accountId = url.searchParams.get('account_id')

  if (!id || !accountId) return NextResponse.json({ error: 'id and account_id required' }, { status: 400 })
  if (!await verifyAccess(user, accountId)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const { data: link } = await supabaseAdmin.from('payment_links').select('id, is_default').eq('id', id).eq('account_id', accountId).maybeSingle()
  if (!link) return NextResponse.json({ error: 'Payment link not found' }, { status: 404 })

  const { error } = await supabaseAdmin.from('payment_links').delete().eq('id', id).eq('account_id', accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Deleting the default must not leave the company with none: the oldest remaining link takes over.
  if (link.is_default) {
    const { data: remaining } = await supabaseAdmin.from('payment_links').select('id, created_at').eq('account_id', accountId)
    const next = pickNewDefault(remaining ?? [])
    if (next) {
      try { await makeDefault(accountId, next.id) } catch { /* the delete itself succeeded; the readers also self-heal */ }
    }
  }
  return NextResponse.json({ success: true })
}
