import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/generated-documents
 * Save metadata for a generated document (distribution resolution or tax statement).
 */
export async function POST(request: NextRequest) {
  const rl = checkRateLimit(getRateLimitKey(request), 10, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked' }, { status: 403 })

  const body = await request.json()
  const { account_id, document_type, fiscal_year, amount, distribution_date, currency, status, metadata } = body

  if (!account_id || !document_type || !fiscal_year) {
    return NextResponse.json({ error: 'account_id, document_type, and fiscal_year are required' }, { status: 400 })
  }

  // Verify the client owns this account
  const accountIds = await getClientAccountIds(contactId)
  if (!accountIds.includes(account_id)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('generated_documents')
    .insert({
      account_id,
      contact_id: contactId,
      document_type,
      fiscal_year,
      amount: amount || null,
      distribution_date: distribution_date || null,
      currency: currency || 'USD',
      status: status || 'downloaded',
      metadata: metadata || {},
    })
    .select('id, document_type, fiscal_year, amount, status, created_at')
    .single()

  if (error) {
    console.error('Failed to save generated document:', error)
    return NextResponse.json({ error: 'Failed to save document' }, { status: 500 })
  }

  return NextResponse.json(data)
}

/**
 * GET /api/portal/generated-documents?account_id=xxx
 * List previously generated documents for the account.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked' }, { status: 403 })

  const accountId = request.nextUrl.searchParams.get('account_id')
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  // Verify the client owns this account
  const accountIds = await getClientAccountIds(contactId)
  if (!accountIds.includes(accountId)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('generated_documents')
    .select('id, document_type, fiscal_year, amount, currency, distribution_date, status, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('Failed to list generated documents:', error)
    return NextResponse.json({ error: 'Failed to list documents' }, { status: 500 })
  }

  return NextResponse.json(data || [])
}
