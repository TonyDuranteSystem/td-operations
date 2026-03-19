import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/bank-accounts?account_id=xxx
 * Returns all bank accounts for the given account.
 *
 * POST /api/portal/bank-accounts
 * Creates a new bank account. Body: { account_id, label, currency, ... }
 *
 * PATCH /api/portal/bank-accounts
 * Updates a bank account. Body: { id, account_id, ...fields }
 * Also handles toggling show_on_invoice.
 *
 * DELETE /api/portal/bank-accounts?id=xxx&account_id=xxx
 */

async function verifyAccess(user: { app_metadata?: Record<string, unknown> }, accountId: string): Promise<boolean> {
  const contactId = user.app_metadata?.contact_id as string | null
  if (!contactId) return true // admin
  const accountIds = await getClientAccountIds(contactId)
  return accountIds.includes(accountId)
}

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = new URL(request.url).searchParams.get('account_id')
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  if (!(await verifyAccess(user, accountId))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('client_bank_accounts')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id, label, currency, account_holder, bank_name, iban, swift_bic, account_number, routing_number, notes, show_on_invoice } = body

  if (!account_id || !label?.trim() || !currency) {
    return NextResponse.json({ error: 'account_id, label, and currency required' }, { status: 400 })
  }

  if (!['USD', 'EUR'].includes(currency)) {
    return NextResponse.json({ error: 'Currency must be USD or EUR' }, { status: 400 })
  }

  if (!(await verifyAccess(user, account_id))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // If this is set as show_on_invoice, uncheck others first
  if (show_on_invoice) {
    await supabaseAdmin
      .from('client_bank_accounts')
      .update({ show_on_invoice: false })
      .eq('account_id', account_id)
  }

  const { data, error } = await supabaseAdmin
    .from('client_bank_accounts')
    .insert({
      account_id,
      label: label.trim(),
      currency,
      account_holder: account_holder?.trim() || null,
      bank_name: bank_name?.trim() || null,
      iban: iban?.trim() || null,
      swift_bic: swift_bic?.trim() || null,
      account_number: account_number?.trim() || null,
      routing_number: routing_number?.trim() || null,
      notes: notes?.trim() || null,
      show_on_invoice: show_on_invoice ?? false,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function PATCH(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { id, account_id, ...updates } = body

  if (!id || !account_id) {
    return NextResponse.json({ error: 'id and account_id required' }, { status: 400 })
  }

  if (!(await verifyAccess(user, account_id))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // If toggling show_on_invoice ON, uncheck others first
  if (updates.show_on_invoice === true) {
    await supabaseAdmin
      .from('client_bank_accounts')
      .update({ show_on_invoice: false })
      .eq('account_id', account_id)
  }

  const { data, error } = await supabaseAdmin
    .from('client_bank_accounts')
    .update(updates)
    .eq('id', id)
    .eq('account_id', account_id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  const accountId = searchParams.get('account_id')

  if (!id || !accountId) {
    return NextResponse.json({ error: 'id and account_id required' }, { status: 400 })
  }

  if (!(await verifyAccess(user, accountId))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { error } = await supabaseAdmin
    .from('client_bank_accounts')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
