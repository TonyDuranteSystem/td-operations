/**
 * POST /api/internal/create-portal-user — Create a portal user (internal only)
 * Protected by CRON_SECRET. Used for lead portal creation when no account exists.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace('Bearer ', '')
  if (!cronSecret || authHeader !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { email, password, full_name, role } = await req.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'email and password required' }, { status: 400 })
  }

  // Check if exists
  const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const existing = (existingList?.users ?? []).find(u => u.email === email)
  if (existing) {
    return NextResponse.json({ error: 'User already exists', id: existing.id }, { status: 409 })
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: role || 'client' },
    user_metadata: { full_name: full_name || email.split('@')[0], must_change_password: true },
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ id: data.user.id, email: data.user.email })
}
