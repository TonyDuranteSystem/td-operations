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

  // Send welcome email with temp password (never expose in API response)
  try {
    const { gmailPost } = await import('@/lib/gmail')
    const loginUrl = `${PORTAL_BASE_URL}/portal/login`
    const welcomeHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 18px;">Welcome to Tony Durante Portal</h1>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
          <p>Hi ${contact.full_name || 'there'},</p>
          <p>Your portal account has been created. Here are your login credentials:</p>
          <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 0 0 8px;"><strong>Email:</strong> ${contact.email}</p>
            <p style="margin: 0;"><strong>Temporary Password:</strong> ${tempPassword}</p>
          </div>
          <p>You will be asked to change your password on first login.</p>
          <a href="${loginUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 8px;">
            Login to Portal
          </a>
        </div>
      </div>
    `
    const subject = 'Your Tony Durante Portal Account'
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: Tony Durante <support@tonydurante.us>`,
      `To: ${contact.email}`,
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
    // Don't fail the whole operation — user is created, password can be sent manually
  }

  // NEVER return temp_password in API response — it was sent via email
  return NextResponse.json({
    success: true,
    user_id: newUser.user.id,
    email: contact.email,
    login_url: `${PORTAL_BASE_URL}/portal/login`,
    message: `Portal account created for ${contact.full_name || contact.email}. Login credentials sent via email.`,
  })
}
