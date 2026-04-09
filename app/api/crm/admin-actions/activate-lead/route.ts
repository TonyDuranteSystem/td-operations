import { NextRequest, NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'activate_lead')) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await req.json()
    const { lead_id } = body

    if (!lead_id) {
      return NextResponse.json({ error: 'lead_id is required' }, { status: 400 })
    }

    // Get lead
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('id, full_name, email, language, phone')
      .eq('id', lead_id)
      .single()

    if (leadErr || !lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
    }

    if (!lead.email) {
      return NextResponse.json({ error: 'Lead has no email — cannot create portal login' }, { status: 400 })
    }

    // Verify offer exists for this lead
    const { data: offer } = await supabaseAdmin
      .from('offers')
      .select('token, status, client_email')
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!offer) {
      return NextResponse.json({ error: 'No offer found for this lead. Create an offer first.' }, { status: 400 })
    }

    // Check if portal login already exists.
    // NOTE: listUsers() returns a discriminated union where the error branch has
    // `users: []` (empty tuple). TypeScript cannot narrow this shape via a simple
    // `if (error)` check because the property-based discriminant doesn't propagate
    // to `data.users`. We handle the error branch defensively, then cast the users
    // array to User[] — runtime behavior is unchanged.
    const listUsersResult = await supabaseAdmin.auth.admin.listUsers()
    if (listUsersResult.error) {
      return NextResponse.json({ error: `Failed to check portal users: ${listUsersResult.error.message}` }, { status: 500 })
    }
    const allUsers = listUsersResult.data.users as User[]
    const existingUser = allUsers.find(
      (u) => u.email?.toLowerCase() === lead.email!.toLowerCase()
    )

    let portalUserId: string | null = null
    let tempPassword: string | null = null
    let alreadyHadLogin = false

    if (existingUser) {
      portalUserId = existingUser.id
      alreadyHadLogin = true
    } else {
      // Create portal user with lead tier
      tempPassword = generateTempPassword()

      const { data: newUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: lead.email,
        password: tempPassword,
        email_confirm: true,
        app_metadata: {
          portal_tier: 'lead',
          role: 'client',
        },
        user_metadata: {
          full_name: lead.full_name,
          language: lead.language || 'en',
          lead_id: lead.id,
        },
      })

      if (authErr) {
        return NextResponse.json({ error: `Portal user creation failed: ${authErr.message}` }, { status: 500 })
      }

      portalUserId = newUser.user.id
    }

    // Update lead status to Offer Sent
    await supabaseAdmin
      .from('leads')
      .update({
        status: 'Offer Sent',
        offer_status: 'Sent',
      })
      .eq('id', lead_id)

    // Update offer status to sent
    await supabaseAdmin
      .from('offers')
      .update({ status: 'sent' })
      .eq('token', offer.token)

    // Send credentials email
    let emailSent = false
    if (!alreadyHadLogin && tempPassword) {
      try {
          const { gmailPost } = await import('@/lib/gmail')
          const isItalian = lead.language === 'Italian' || lead.language === 'it'
          const subject = isItalian
            ? 'Il tuo portale Tony Durante è pronto'
            : 'Your Tony Durante Portal is ready'
          const body = isItalian
            ? `Ciao ${lead.full_name.split(' ')[0]},\n\nIl tuo portale è pronto. Accedi per visualizzare la tua proposta.\n\nLink: https://portal.tonydurante.us\nEmail: ${lead.email}\nPassword temporanea: ${tempPassword}\n\nCambia la password dopo il primo accesso.\n\nA presto,\nTony Durante LLC`
            : `Hi ${lead.full_name.split(' ')[0]},\n\nYour portal is ready. Log in to review your proposal.\n\nLink: https://portal.tonydurante.us\nEmail: ${lead.email}\nTemporary password: ${tempPassword}\n\nPlease change your password after your first login.\n\nBest regards,\nTony Durante LLC`

          const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
          const raw = Buffer.from(
            `From: Tony Durante LLC <support@tonydurante.us>\r\n` +
            `To: ${lead.email}\r\n` +
            `Subject: ${encodedSubject}\r\n` +
            `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
            body
          ).toString('base64url')

          await gmailPost('/messages/send', { raw })
          emailSent = true
      } catch {
        // Email send failed — portal login was still created
      }
    }

    // Log to action_log
    await supabaseAdmin.from('action_log').insert({
      action_type: 'activate_lead',
      table_name: 'leads',
      record_id: lead_id,
      summary: `Lead activated via CRM: ${lead.full_name}. Portal login ${alreadyHadLogin ? 'already existed' : 'created'}. Offer: ${offer.token}`,
      details: {
        portal_user_id: portalUserId,
        offer_token: offer.token,
        email_sent: emailSent,
        already_had_login: alreadyHadLogin,
        source: 'crm-button',
      },
    })

    return NextResponse.json({
      success: true,
      portal_user_id: portalUserId,
      already_had_login: alreadyHadLogin,
      email_sent: emailSent,
      offer_token: offer.token,
      message: alreadyHadLogin
        ? `Lead already had portal access. Offer status updated to sent.`
        : `Portal login created and credentials ${emailSent ? 'sent' : 'NOT sent (email failed)'}. Offer is waiting in portal.`,
    })
  } catch (err) {
    console.error('Activate lead error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let password = ''
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password + '!'
}
