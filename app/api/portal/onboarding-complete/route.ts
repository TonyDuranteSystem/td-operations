import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/onboarding-complete
 * Marks onboarding as complete and/or clears must_change_password flag
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown> = {}
  try { body = await request.json() } catch { /* empty body is fine */ }

  const updates: Record<string, unknown> = { ...user.user_metadata }

  if (body.clear_password_flag) {
    updates.must_change_password = false
  } else {
    updates.onboarding_completed = true
  }

  await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: updates,
  })

  return NextResponse.json({ success: true })
}
