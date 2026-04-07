import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/contacts/search?q=term
 * Lightweight contact search for comboboxes. Returns id, full_name, email, phone.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ contacts: [] })

  const supabase = createClient()
  const pattern = `%${q}%`

  const { data, error } = await supabase
    .from('contacts')
    .select('id, full_name, email, phone')
    .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
    .order('full_name')
    .limit(15)

  if (error) return NextResponse.json({ contacts: [], error: error.message }, { status: 500 })
  return NextResponse.json({ contacts: data ?? [] })
}
