import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { PORTAL_BASE_URL } from '@/lib/config'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/admin/create-user
 * Admin-only: creates a Supabase Auth user with client role for the portal.
 * Body: { account_id, contact_id? }
 */
export async function POST(request: NextRequest) {
  // Admin auth check
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { account_id, contact_id } = body

  if (!account_id) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  // Get the contact (primary if not specified)
  let targetContactId = contact_id
  if (!targetContactId) {
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', account_id)
      .limit(1)

    if (!links || links.length === 0) {
      return NextResponse.json({ error: 'No contacts linked to this account' }, { status: 400 })
    }
    targetContactId = links[0].contact_id
  }

  // Get contact details
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('full_name, email')
    .eq('id', targetContactId)
    .single()

  if (!contact?.email) {
    return NextResponse.json({ error: 'Contact has no email address' }, { status: 400 })
  }

  // Check if user already exists (search by email)
  const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = (existingList?.users ?? []).find(u => u.email === contact.email)

  if (existingUser) {
    return NextResponse.json({ error: `User already exists: ${contact.email}` }, { status: 409 })
  }

  // Generate temporary password
  const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

  // Create auth user with app_metadata (tamper-proof)
  const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: contact.email,
    password: tempPassword,
    email_confirm: true, // Auto-confirm — we send our own welcome email
    app_metadata: {
      role: 'client',
      contact_id: targetContactId,
    },
    user_metadata: {
      full_name: contact.full_name,
      must_change_password: true,
    },
  })

  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 500 })
  }

  // Update account portal flags
  await supabaseAdmin
    .from('accounts')
    .update({
      portal_account: true,
      portal_created_date: new Date().toISOString().split('T')[0],
    })
    .eq('id', account_id)

  return NextResponse.json({
    success: true,
    user_id: newUser.user.id,
    email: contact.email,
    temp_password: tempPassword,
    login_url: `${PORTAL_BASE_URL}/portal/login`,
    message: `Portal account created for ${contact.full_name} (${contact.email}). Temporary password: ${tempPassword}`,
  })
}
