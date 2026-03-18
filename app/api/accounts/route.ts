import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/accounts?q=search&limit=8
 * Lightweight account search for the AccountCombobox component.
 * Protected by auth middleware (not in exemption list).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') ?? ''
  const limit = Math.min(Number(searchParams.get('limit') ?? '8'), 25)

  const supabase = createClient()

  let query = supabase
    .from('accounts')
    .select('id, company_name, status')
    .order('company_name')
    .limit(limit)

  if (q.length >= 2) {
    query = query.ilike('company_name', `%${q}%`)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ accounts: data ?? [] })
}
