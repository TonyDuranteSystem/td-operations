import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail, listAllAuthUsers } from '@/lib/auth-admin-helpers'
import { isAdmin } from '@/lib/auth'
import { CRM_BASE_URL } from '@/lib/config'
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
  const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

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

  // Send welcome email with temp password
  try {
    const { gmailPost } = await import('@/lib/gmail')
    const loginUrl = `${CRM_BASE_URL}/login`
    const welcomeHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 18px;">Tony Durante — Team Access</h1>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
          <p>Hi ${full_name},</p>
          <p>Your CRM dashboard account has been created. Here are your login credentials:</p>
          <div style="background: #18181b; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 0 0 8px; color: #ffffff; font-size: 15px;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 0; color: #ffffff; font-size: 15px;"><strong>Temporary Password:</strong> <code style="background: #fef3c7; padding: 4px 8px; border-radius: 4px; font-size: 16px; font-weight: bold; color: #92400e;">${tempPassword}</code></p>
          </div>
          <p>You will be asked to change your password on first login.</p>
          <a href="${loginUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 8px;">
            Login to CRM
          </a>
          <p style="color: #71717a; font-size: 12px; margin-top: 16px;">Role: ${role === 'admin' ? 'Administrator' : 'Team Member'}</p>
        </div>
      </div>
    `
    const subject = 'Your Tony Durante CRM Account'
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: Tony Durante <support@tonydurante.us>`,
      `To: ${email}`,
      `Subject: ${encodedSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(welcomeHtml).toString('base64'),
      `--${boundary}--`,
    ].join('\r\n')
    await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
  } catch (emailErr) {
    console.error('Welcome email failed:', emailErr)
  }

  return NextResponse.json({
    success: true,
    user_id: newUser.user.id,
    email,
    message: `Dashboard account created for ${full_name}. Login credentials sent via email.`,
  })
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
