import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/language — Update portal language preference
 * Body: { language: 'en' | 'it' }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { language } = body

  if (!language || !['en', 'it'].includes(language)) {
    return NextResponse.json({ error: 'Language must be en or it' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...user.user_metadata,
      portal_language: language,
    },
  })

  if (error) {
    return NextResponse.json({ error: 'Failed to update language preference' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
