import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail, listAllAuthUsers } from '@/lib/auth-admin-helpers'
import { isAdmin } from '@/lib/auth'
import { generateTempPassword, sendStaffCredentialsEmail } from '@/lib/auth/staff-credentials'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/team-management
 * Admin-only: list all dashboard users (non-client).
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const allUsers = await listAllAuthUsers()
  const dashboardUsers = allUsers
    .filter(u => u.app_metadata?.role !== 'client')
    .map(u => ({
      id: u.id,
      email: u.email,
      full_name: u.user_metadata?.full_name || u.email?.split('@')[0] || 'Unknown',
      role: isAdminUser(u) ? 'admin' : 'team',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      disabled: !!u.banned_until,
    }))
    .sort((a, b) => {
      // Admins first, then by name
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1
      return a.full_name.localeCompare(b.full_name)
    })

  return NextResponse.json({ users: dashboardUsers })
}

/**
 * POST /api/team-management
 * Admin-only: create a new dashboard user (admin or team).
 * Body: { email, full_name, role: 'admin' | 'team' }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { email, full_name, role } = body

  if (!email || !full_name) {
    return NextResponse.json({ error: 'email and full_name required' }, { status: 400 })
  }
  if (!['admin', 'team'].includes(role)) {
    return NextResponse.json({ error: 'role must be admin or team' }, { status: 400 })
  }

  // Check for duplicate (paginated via findAuthUserByEmail — P1.9)
  const existingUser = await findAuthUserByEmail(email)
  if (existingUser) {
    return NextResponse.json({ error: `User already exists: ${email}` }, { status: 409 })
  }

  // Generate temp password
  const tempPassword = generateTempPassword()

  // Create auth user
  const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    app_metadata: { role },
    user_metadata: { full_name, must_change_password: true },
  })

  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 500 })
  }

  // Send welcome email with temp password. If the send fails the admin is told
  // and gets the password back once — the old code only console.error'd a
  // failed send and still reported success.
  const emailSent = await sendStaffCredentialsEmail({ kind: 'created', fullName: full_name, email, tempPassword, role })

  return NextResponse.json(
    {
      success: true,
      user_id: newUser.user.id,
      email,
      emailSent,
      ...(emailSent ? {} : { tempPassword }),
      message: emailSent
        ? `Dashboard account created for ${full_name}. Login credentials sent via email.`
        : `Dashboard account created for ${full_name}, but the email could NOT be sent. Temporary password: ${tempPassword}`,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * PATCH /api/team-management
 * Admin-only: update a dashboard user's role or disabled status.
 * Body: { user_id, role?: 'admin' | 'team', disabled?: boolean }
 */
export async function PATCH(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { user_id, role, disabled } = body

  if (!user_id) {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  // Self-protection: can't change own role or disable self
  if (user_id === user.id) {
    return NextResponse.json({ error: 'Cannot modify your own account' }, { status: 400 })
  }

  if (role !== undefined) {
    if (!['admin', 'team'].includes(role)) {
      return NextResponse.json({ error: 'role must be admin or team' }, { status: 400 })
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
      app_metadata: { role },
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (disabled !== undefined) {
    const banDuration = disabled ? '876000h' : 'none'
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
      ban_duration: banDuration,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

/**
 * DELETE /api/team-management
 * Admin-only: permanently delete a dashboard user.
 * Body: { user_id }
 */
export async function DELETE(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { user_id } = body

  if (!user_id) {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  // Self-protection: can't delete self
  if (user_id === user.id) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(user_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

// --- Helpers ---

const ADMIN_EMAILS = ['antonio.durante@tonydurante.us']

function isAdminUser(u: { email?: string; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }): boolean {
  if (ADMIN_EMAILS.includes(u.email ?? '')) return true
  return u.app_metadata?.role === 'admin' || u.user_metadata?.role === 'admin'
}
