import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { PORTAL_BASE_URL } from '@/lib/config'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/crm/admin-actions/contact-portal
 * Admin-only: manage portal for a contact (change tier, reset password, create portal)
 * Body: { action: 'change_tier' | 'reset_password' | 'create_portal', contact_id, tier? }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { action, contact_id, tier } = body

  if (!contact_id) {
    return NextResponse.json({ error: 'contact_id required' }, { status: 400 })
  }

  // Get contact
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name, email, portal_tier')
    .eq('id', contact_id)
    .single()

  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  if (!contact.email) {
    return NextResponse.json({ error: 'Contact has no email address' }, { status: 400 })
  }

  // Find auth user by email
  const findAuthUser = async () => {
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    return (list?.users ?? []).find(u => u.email === contact.email)
  }

  if (action === 'change_tier') {
    const validTiers = ['lead', 'onboarding', 'active', 'full']
    if (!tier || !validTiers.includes(tier)) {
      return NextResponse.json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` }, { status: 400 })
    }

    // Update contacts table
    await supabaseAdmin
      .from('contacts')
      .update({ portal_tier: tier, updated_at: new Date().toISOString() })
      .eq('id', contact_id)

    // Also sync tier to all linked accounts
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contact_id)
    for (const link of links ?? []) {
      await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: tier, updated_at: new Date().toISOString() })
        .eq('id', link.account_id)
    }

    // Update auth app_metadata
    const authUser = await findAuthUser()
    if (authUser) {
      await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
        app_metadata: { ...authUser.app_metadata, portal_tier: tier },
      })
    }

    // Log
    await supabaseAdmin.from('action_log').insert({
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'update',
      table_name: 'contacts',
      record_id: contact_id,
      summary: `Portal tier changed to ${tier}`,
      details: { previous_tier: contact.portal_tier, new_tier: tier },
    })

    return NextResponse.json({ success: true, message: `Tier changed to ${tier}` })
  }

  if (action === 'reset_password') {
    const authUser = await findAuthUser()
    if (!authUser) {
      return NextResponse.json({ error: 'No portal account found for this contact' }, { status: 404 })
    }

    const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

    // Fix incomplete auth metadata while resetting password
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contact_id)
    const accountIds = (links ?? []).map(l => l.account_id)
    const effectiveTier = contact.portal_tier || 'active'

    await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      password: tempPassword,
      user_metadata: { ...authUser.user_metadata, must_change_password: true },
      app_metadata: {
        ...authUser.app_metadata,
        role: 'client',
        contact_id: contact_id,
        portal_tier: effectiveTier,
        ...(accountIds.length > 0 ? { account_ids: accountIds } : {}),
      },
    })

    // Ensure portal flags on all linked accounts
    if (accountIds.length > 0) {
      await supabaseAdmin
        .from('accounts')
        .update({
          portal_account: true,
          portal_tier: effectiveTier,
          portal_created_date: new Date().toISOString().split('T')[0],
        })
        .in('id', accountIds)
    }

    // Ensure contact has portal_tier set
    if (!contact.portal_tier) {
      await supabaseAdmin
        .from('contacts')
        .update({ portal_tier: effectiveTier, updated_at: new Date().toISOString() })
        .eq('id', contact_id)
    }

    // Send reset email
    try {
      const { gmailPost } = await import('@/lib/gmail')
      const loginUrl = `${PORTAL_BASE_URL}/portal/login`
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 18px;">Password Reset — Tony Durante Portal</h1>
          </div>
          <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
            <p>Hi ${contact.full_name || 'there'},</p>
            <p>Your portal password has been reset. Here are your new credentials:</p>
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
      const subject = 'Password Reset — Tony Durante Portal'
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
      const boundary = `boundary_${Date.now()}`
      const rawEmail = [
        'From: Tony Durante <support@tonydurante.us>',
        `To: ${contact.email}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(html).toString('base64'),
        `--${boundary}--`,
      ].join('\r\n')
      await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
    } catch (emailErr) {
      console.error('Reset email failed:', emailErr)
    }

    // Log
    await supabaseAdmin.from('action_log').insert({
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'update',
      table_name: 'contacts',
      record_id: contact_id,
      summary: 'Portal password reset',
      details: {},
    })

    return NextResponse.json({ success: true, message: 'Password reset. New credentials sent via email.' })
  }

  if (action === 'create_portal') {
    // Check if already exists — if so, fix metadata and resend credentials instead of 409
    const existing = await findAuthUser()
    if (existing) {
      const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
      const { data: existingLinks } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id')
        .eq('contact_id', contact_id)
      const existingAccountIds = (existingLinks ?? []).map(l => l.account_id)
      const existingTier = contact.portal_tier || 'active'

      // Fix auth metadata + reset password
      await supabaseAdmin.auth.admin.updateUserById(existing.id, {
        password: tempPassword,
        app_metadata: {
          ...existing.app_metadata,
          role: 'client',
          contact_id: contact_id,
          portal_tier: existingTier,
          ...(existingAccountIds.length > 0 ? { account_ids: existingAccountIds } : {}),
        },
        user_metadata: {
          ...existing.user_metadata,
          full_name: contact.full_name,
          must_change_password: true,
        },
      })

      // Set portal flags on accounts
      if (existingAccountIds.length > 0) {
        await supabaseAdmin
          .from('accounts')
          .update({
            portal_account: true,
            portal_tier: existingTier,
            portal_created_date: new Date().toISOString().split('T')[0],
          })
          .in('id', existingAccountIds)
      }

      // Set portal_tier on contact if not set
      if (!contact.portal_tier) {
        await supabaseAdmin
          .from('contacts')
          .update({ portal_tier: existingTier, updated_at: new Date().toISOString() })
          .eq('id', contact_id)
      }

      // Send welcome email with new credentials
      try {
        const { gmailPost } = await import('@/lib/gmail')
        const loginUrl = `${PORTAL_BASE_URL}/portal/login`
        const html = `
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
        const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
        const boundary = `boundary_${Date.now()}`
        const rawEmail = [
          'From: Tony Durante <support@tonydurante.us>',
          `To: ${contact.email}`,
          `Subject: ${encodedSubject}`,
          'MIME-Version: 1.0',
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(html).toString('base64'),
          `--${boundary}--`,
        ].join('\r\n')
        await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
      } catch (emailErr) {
        console.error('Welcome email failed:', emailErr)
      }

      await supabaseAdmin.from('action_log').insert({
        actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
        action_type: 'update',
        table_name: 'contacts',
        record_id: contact_id,
        summary: `Portal account repaired and credentials resent for ${contact.full_name}`,
        details: { email: contact.email, user_id: existing.id },
      })

      return NextResponse.json({
        success: true,
        user_id: existing.id,
        message: `Portal account repaired for ${contact.full_name}. New credentials sent via email.`,
      })
    }

    const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

    // Get linked accounts for app_metadata
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contact_id)

    const accountIds = (links ?? []).map(l => l.account_id)

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: contact.email,
      password: tempPassword,
      email_confirm: true,
      app_metadata: {
        role: 'client',
        contact_id,
        portal_tier: contact.portal_tier || 'active',
        ...(accountIds.length > 0 ? { account_ids: accountIds } : {}),
      },
      user_metadata: {
        full_name: contact.full_name,
        must_change_password: true,
      },
    })

    if (createError) {
      return NextResponse.json({ error: createError.message }, { status: 500 })
    }

    // Update portal_tier on contact if not set
    const effectiveTier = contact.portal_tier || 'active'
    if (!contact.portal_tier) {
      await supabaseAdmin
        .from('contacts')
        .update({ portal_tier: effectiveTier, updated_at: new Date().toISOString() })
        .eq('id', contact_id)
    }

    // Update linked accounts portal flags + sync tier
    if (accountIds.length > 0) {
      await supabaseAdmin
        .from('accounts')
        .update({
          portal_account: true,
          portal_tier: effectiveTier,
          portal_created_date: new Date().toISOString().split('T')[0],
        })
        .in('id', accountIds)
    }

    // Send welcome email
    try {
      const { gmailPost } = await import('@/lib/gmail')
      const loginUrl = `${PORTAL_BASE_URL}/portal/login`
      const html = `
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
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
      const boundary = `boundary_${Date.now()}`
      const rawEmail = [
        'From: Tony Durante <support@tonydurante.us>',
        `To: ${contact.email}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(html).toString('base64'),
        `--${boundary}--`,
      ].join('\r\n')
      await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
    } catch (emailErr) {
      console.error('Welcome email failed:', emailErr)
    }

    // Log
    await supabaseAdmin.from('action_log').insert({
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'create',
      table_name: 'contacts',
      record_id: contact_id,
      summary: `Portal account created for ${contact.full_name}`,
      details: { email: contact.email, user_id: newUser.user.id },
    })

    return NextResponse.json({
      success: true,
      user_id: newUser.user.id,
      message: `Portal account created for ${contact.full_name}. Credentials sent via email.`,
    })
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}
