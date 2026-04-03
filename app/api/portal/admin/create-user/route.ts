import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { PORTAL_BASE_URL } from '@/lib/config'
import { NextRequest, NextResponse } from 'next/server'
import { autoCreatePortalUser, sendPortalWelcomeEmail } from '@/lib/portal/auto-create'

/**
 * POST /api/portal/admin/create-user
 * Admin-only: creates a Supabase Auth user with client role for the portal.
 * Body: { account_id, contact_id?, resend?: boolean }
 *
 * If user already exists:
 *   - Verifies/fixes app_metadata (contact_id, role)
 *   - If resend=true, generates new temp password and re-sends welcome email
 *   - Returns success instead of 409
 */
export async function POST(request: NextRequest) {
  // Admin auth check
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { account_id, contact_id, resend } = body

  if (!account_id) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  // Resolve contact
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
    .select('full_name, email, language')
    .eq('id', targetContactId)
    .single()

  if (!contact?.email) {
    return NextResponse.json({ error: 'Contact has no email address' }, { status: 400 })
  }

  const contactLang = contact.language === 'Italian' || contact.language === 'it' ? 'it' : 'en'

  // Check if user already exists
  const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = (existingList?.users ?? []).find(u => u.email === contact.email)

  if (existingUser) {
    // User already exists — verify/fix metadata and optionally resend credentials
    const meta = existingUser.app_metadata || {}
    const needsFix = meta.contact_id !== targetContactId || meta.role !== 'client'

    if (needsFix) {
      await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        app_metadata: {
          ...meta,
          role: 'client',
          contact_id: targetContactId,
        },
      })
    }

    // Ensure portal flags are set on account
    await supabaseAdmin
      .from('accounts')
      .update({
        portal_account: true,
        portal_created_date: new Date().toISOString().split('T')[0],
      })
      .eq('id', account_id)

    if (resend) {
      // Generate new temp password and resend welcome email
      const newTempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
      await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        password: newTempPassword,
        user_metadata: {
          ...existingUser.user_metadata,
          must_change_password: true,
        },
      })

      const emailResult = await sendPortalWelcomeEmail({
        email: contact.email,
        fullName: contact.full_name,
        tempPassword: newTempPassword,
        language: contactLang,
      })

      return NextResponse.json({
        success: true,
        already_existed: true,
        metadata_fixed: needsFix,
        credentials_resent: emailResult.success,
        user_id: existingUser.id,
        email: contact.email,
        login_url: `${PORTAL_BASE_URL}/portal/login`,
        message: emailResult.success
          ? `User already existed. New credentials sent to ${contact.email}.`
          : `User already existed. Credentials reset but email failed: ${emailResult.error}`,
      })
    }

    return NextResponse.json({
      success: true,
      already_existed: true,
      metadata_fixed: needsFix,
      user_id: existingUser.id,
      email: contact.email,
      login_url: `${PORTAL_BASE_URL}/portal/login`,
      message: `User already exists (${contact.email}). ${needsFix ? 'Metadata was fixed.' : 'No changes needed.'} Pass resend=true to send new credentials.`,
    })
  }

  // New user — use autoCreatePortalUser for consistent creation
  const result = await autoCreatePortalUser({
    accountId: account_id,
    contactId: targetContactId,
    tier: 'active', // CRM manual creation = full active client
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  // Send welcome email (autoCreatePortalUser doesn't send email itself)
  if (result.tempPassword) {
    const emailResult = await sendPortalWelcomeEmail({
      email: contact.email,
      fullName: contact.full_name,
      tempPassword: result.tempPassword,
      language: contactLang,
    })

    if (!emailResult.success) {
      console.error('Welcome email failed:', emailResult.error)
    }
  }

  return NextResponse.json({
    success: true,
    user_id: result.userId,
    email: contact.email,
    login_url: `${PORTAL_BASE_URL}/portal/login`,
    message: `Portal account created for ${contact.full_name || contact.email}. Login credentials sent via email.`,
  })
}
