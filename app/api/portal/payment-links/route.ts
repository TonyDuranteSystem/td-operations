import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

async function verifyAccess(user: { app_metadata?: Record<string, unknown> }, accountId: string) {
  const contactId = user.app_metadata?.contact_id as string | undefined
  if (contactId) {
    const { data } = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId)
    if (!data?.some(r => r.account_id === accountId)) return false
  }
  return true
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

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id, label, url, gateway, amount, currency, is_default } = body

  if (!account_id || !label || !url) return NextResponse.json({ error: 'label, url, account_id required' }, { status: 400 })
  if (!await verifyAccess(user, account_id)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  // If this is default, unset other defaults
  if (is_default) {
    await supabaseAdmin.from('payment_links').update({ is_default: false }).eq('account_id', account_id)
  }

  const { data, error } = await supabaseAdmin
    .from('payment_links')
    .insert({ account_id, label, url, gateway: gateway || 'other', amount: amount || null, currency: currency || 'USD', is_default: is_default || false })
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
  const { id, account_id, is_default } = body

  if (!id || !account_id) return NextResponse.json({ error: 'id and account_id required' }, { status: 400 })
  if (!await verifyAccess(user, account_id)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  if (is_default) {
    await supabaseAdmin.from('payment_links').update({ is_default: false }).eq('account_id', account_id)
    await supabaseAdmin.from('payment_links').update({ is_default: true }).eq('id', id)
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

  await supabaseAdmin.from('payment_links').delete().eq('id', id).eq('account_id', accountId)
  return NextResponse.json({ success: true })
}
