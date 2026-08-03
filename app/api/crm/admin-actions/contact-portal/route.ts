import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { isAdmin } from '@/lib/auth'
import { PORTAL_BASE_URL } from '@/lib/config'
import { PORTAL_TIERS, type PortalTier } from '@/lib/portal/tier-config'
import { syncTier } from '@/lib/operations/sync-tier'
import { NextRequest, NextResponse } from 'next/server'
import { generateTempPassword } from "@/lib/portal/temp-password"

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
    .select('id, full_name, email, portal_tier, language')
    .eq('id', contact_id)
    .single()

  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  if (!contact.email) {
    return NextResponse.json({ error: 'Contact has no email address' }, { status: 400 })
  }

  // Find auth user by email (paginated — P1.9)
  const findAuthUser = async () => findAuthUserByEmail(contact.email!)

  if (action === 'change_tier') {
    const validTiers: readonly string[] = PORTAL_TIERS
    if (!tier || !validTiers.includes(tier)) {
      return NextResponse.json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` }, { status: 400 })
    }

    const actor = `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`

    // Route the write through syncTier per linked account. syncTier handles
    // the account write, the contact-tier recompute (MAX across the contact's
    // remaining valid account tiers, which here equals `tier` because every
    // linked account is being set to the same value), and the auth.app_metadata
    // sync — replacing the previous 3 separate non-atomic writes.
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contact_id)

    for (const link of links ?? []) {
      await syncTier({
        accountId: link.account_id,
        newTier: tier as PortalTier,
        reason: 'admin: change_tier via contact-portal',
        actor,
      })
    }

    // Fallback path: contact has no linked accounts (rare — tier-only contact).
    // The loop above never ran, so write the contact tier + auth metadata
    // directly so the admin override sticks.
    if (!links || links.length === 0) {
      /* eslint-disable no-restricted-syntax -- pre-P2.4 Phase D1 raw contacts portal_tier update (no-account fallback only); extract when reconcileTier() lands */
      await supabaseAdmin
        .from('contacts')
        .update({ portal_tier: tier, updated_at: new Date().toISOString() })
        .eq('id', contact_id)
      /* eslint-enable no-restricted-syntax */
      const authUser = await findAuthUser()
      if (authUser) {
        await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          app_metadata: { ...authUser.app_metadata, portal_tier: tier },
        })
      }
    }

    // Log
    await supabaseAdmin.from('action_log').insert({
      actor,
      action_type: 'update',
      table_name: 'contacts',
      record_id: contact_id,
      summary: `Portal tier changed to ${tier}`,
      details: { previous_tier: contact.portal_tier, new_tier: tier, accounts_synced: links?.length ?? 0 },
    })

    return NextResponse.json({ success: true, message: `Tier changed to ${tier}` })
  }

  if (action === 'reset_password') {
    const authUser = await findAuthUser()
    if (!authUser) {
      return NextResponse.json({ error: 'No portal account found for this contact' }, { status: 404 })
    }

    const tempPassword = generateTempPassword()

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
      /* eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update portal_account/portal_tier */
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
      /* eslint-disable no-restricted-syntax -- pre-P2.4 Phase D1 raw contacts.update portal_tier */
      await supabaseAdmin
        .from('contacts')
        .update({ portal_tier: effectiveTier, updated_at: new Date().toISOString() })
        .eq('id', contact_id)
      /* eslint-enable no-restricted-syntax */
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
      const tempPassword = generateTempPassword()
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
        /* eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update portal_account/portal_tier */
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
        /* eslint-disable no-restricted-syntax -- pre-P2.4 Phase D1 raw contacts.update portal_tier */
        await supabaseAdmin
          .from('contacts')
          .update({ portal_tier: existingTier, updated_at: new Date().toISOString() })
          .eq('id', contact_id)
        /* eslint-enable no-restricted-syntax */
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

    const tempPassword = generateTempPassword()

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
      /* eslint-disable no-restricted-syntax -- pre-P2.4 Phase D1 raw contacts.update portal_tier */
      await supabaseAdmin
        .from('contacts')
        .update({ portal_tier: effectiveTier, updated_at: new Date().toISOString() })
        .eq('id', contact_id)
      /* eslint-enable no-restricted-syntax */
    }

    // Update linked accounts portal flags + sync tier
    if (accountIds.length > 0) {
      /* eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update portal_account/portal_tier */
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

  if (action === 'revoke_access') {
    const { account_id } = body
    if (!account_id) {
      return NextResponse.json({ error: 'account_id required for revoke_access' }, { status: 400 })
    }

    await supabaseAdmin
      .from('account_contacts')
      .delete()
      .eq('contact_id', contact_id)
      .eq('account_id', account_id)

    const { data: remaining } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contact_id)

    if (!remaining || remaining.length === 0) {
      const authUser = await findAuthUser()
      if (authUser) {
        await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          ban_duration: '876600h',
        })
      }
    }

    await supabaseAdmin.from('action_log').insert({
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'update',
      table_name: 'account_contacts',
      record_id: contact_id,
      account_id,
      summary: `Portal access revoked for ${contact.full_name} on account ${account_id}`,
      details: { remaining_accounts: remaining?.length ?? 0, globally_banned: !remaining || remaining.length === 0 },
    })

    return NextResponse.json({
      success: true,
      message: `Access revoked${!remaining || remaining.length === 0 ? ' (user banned — no remaining accounts)' : ''}`,
    })
  }

  if (action === 'restore_access') {
    const { account_id } = body
    if (!account_id) {
      return NextResponse.json({ error: 'account_id required for restore_access' }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabaseAdmin.from('account_contacts').upsert(
      { account_id, contact_id, role: 'Member' } as any,
      { onConflict: 'account_id,contact_id' },
    )

    // Guard: do NOT lift a DELIBERATE admin suspension here. revoke/restore_access
    // is per-company membership; suspension is a separate login-level action.
    // Both share the auth ban switch, so without this guard, restoring one
    // company's membership would silently un-suspend a deliberately-suspended
    // login. The app_metadata.suspended flag (set by the suspend action)
    // distinguishes the two. A membership-revoke ban has no flag and is lifted.
    const authUser = await findAuthUser()
    const isDeliberatelySuspended = authUser?.app_metadata?.suspended === true
    if (authUser && !isDeliberatelySuspended) {
      await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
        ban_duration: 'none',
      })
    }

    await supabaseAdmin.from('action_log').insert({
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'update',
      table_name: 'account_contacts',
      record_id: contact_id,
      account_id,
      summary: `Portal access restored for ${contact.full_name} on account ${account_id}${isDeliberatelySuspended ? ' (login kept suspended — use Unsuspend to lift)' : ''}`,
      details: { auth_user_found: !!authUser, kept_suspended: isDeliberatelySuspended },
    })

    return NextResponse.json({
      success: true,
      message: isDeliberatelySuspended
        ? 'Membership restored. Login remains suspended — use Unsuspend to lift it.'
        : 'Access restored',
    })
  }

  // ── Suspend / Unsuspend the portal LOGIN ──────────────────────────────────
  // Blocks (or restores) the person's ability to log in at the auth layer,
  // WITHOUT changing portal tier or company status. One auth user per email →
  // suspend affects every company that login can reach (the UI confirms the
  // blast radius). ban_duration '876600h' (~100y) bans; 'none' lifts it.
  // Mechanism is the same proven switch used by revoke/restore_access above and
  // the account-audit portal-access route.
  if (action === 'suspend' || action === 'unsuspend') {
    const isSuspend = action === 'suspend'
    const actor = `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`

    const authUser = await findAuthUser()
    if (!authUser) {
      return NextResponse.json({ error: 'No portal login found for this contact' }, { status: 404 })
    }

    // Tag the ban as a DELIBERATE admin suspension via app_metadata.suspended.
    // This is what lets restore_access (per-company membership restore) tell a
    // deliberate suspension apart from a membership-revoke ban and refuse to
    // silently un-suspend. Merge to preserve existing app_metadata.
    const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      ban_duration: isSuspend ? '876600h' : 'none',
      app_metadata: { ...authUser.app_metadata, suspended: isSuspend },
    })
    if (banErr) {
      return NextResponse.json({ error: banErr.message }, { status: 500 })
    }

    // Notify the client (bilingual by contact language — same convention as the
    // rest of the codebase: 'Italian'/'it' → IT, else EN). Suspend email has no
    // login button (they can't log in); restore email links back to the portal.
    const isItalian = contact.language === 'Italian' || contact.language === 'it'
    try {
      const { gmailPost } = await import('@/lib/gmail')
      const loginUrl = `${PORTAL_BASE_URL}/portal/login`
      const greetingName = contact.full_name || (isItalian ? 'ciao' : 'there')
      const subject = isSuspend
        ? (isItalian ? 'Il tuo accesso al portale Tony Durante è stato sospeso' : 'Your Tony Durante portal access has been suspended')
        : (isItalian ? 'Il tuo accesso al portale Tony Durante è stato ripristinato' : 'Your Tony Durante portal access has been restored')
      const heading = isSuspend
        ? (isItalian ? 'Accesso sospeso' : 'Access suspended')
        : (isItalian ? 'Accesso ripristinato' : 'Access restored')
      const bodyText = isSuspend
        ? (isItalian
            ? `Ciao ${greetingName}, il tuo accesso al portale clienti Tony Durante è stato sospeso dal nostro team. Finché è sospeso non potrai accedere. Se pensi che sia un errore, rispondi a questa email e ti aiuteremo.`
            : `Hi ${greetingName}, your access to the Tony Durante client portal has been suspended by our team. While suspended, you won't be able to log in. If you think this is a mistake, just reply to this email and we'll help.`)
        : (isItalian
            ? `Ciao ${greetingName}, il tuo accesso al portale clienti Tony Durante è stato ripristinato. Puoi accedere di nuovo dal portale. Bentornato.`
            : `Hi ${greetingName}, your access to the Tony Durante client portal has been restored. You can log in again at the portal. Welcome back.`)
      const ctaBlock = isSuspend
        ? ''
        : `<a href="${loginUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 8px;">${isItalian ? 'Vai al portale' : 'Go to the portal'}</a>`
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 18px;">${heading} — Tony Durante</h1>
          </div>
          <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
            <p>${bodyText}</p>
            ${ctaBlock}
          </div>
        </div>
      `
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
      console.error(`${action} email failed:`, emailErr)
    }

    await supabaseAdmin.from('action_log').insert({
      actor,
      action_type: 'update',
      table_name: 'auth.users',
      record_id: contact_id,
      summary: `Portal login ${isSuspend ? 'suspended' : 'unsuspended'} for ${contact.full_name}`,
      details: { auth_user_id: authUser.id, email: contact.email },
    })

    return NextResponse.json({
      success: true,
      message: isSuspend
        ? `${contact.full_name}'s portal login suspended. Notice sent to the client.`
        : `${contact.full_name}'s portal login restored. Notice sent to the client.`,
    })
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}
