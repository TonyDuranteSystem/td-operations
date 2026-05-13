import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { autoCreatePortalUser, sendPortalWelcomeEmail } from '@/lib/portal/auto-create'
import { notifyClientOfAdminMessage } from '@/lib/portal/notifications'

interface MemberPayload {
  member_type: 'individual' | 'company'
  is_signer?: boolean
  full_name?: string
  company_name?: string
  ein?: string
  email?: string
  phone?: string
  ownership_pct?: string | number
  address_street?: string
  address_city?: string
  address_state?: string
  address_zip?: string
  address_country?: string
  representative_name?: string
  representative_email?: string
  representative_phone?: string
  representative_address_street?: string
  representative_address_city?: string
  representative_address_state?: string
  representative_address_zip?: string
  representative_address_country?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: { token: string; access_code: string } },
) {
  const { token, access_code } = params

  // 1. Validate request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: request, error: reqErr } = await (supabaseAdmin as any)
    .from('member_info_requests')
    .select('id, account_id, status, company_name')
    .eq('token', token)
    .eq('access_code', access_code)
    .single() as { data: { id: string; account_id: string; status: string; company_name: string } | null; error: unknown }

  if (reqErr || !request) {
    return NextResponse.json({ error: 'Invalid or expired link.' }, { status: 404 })
  }

  if (request.status === 'submitted') {
    return NextResponse.json({ error: 'This form has already been submitted.' }, { status: 409 })
  }

  // 2. Parse body
  const body = await req.json()
  const members: MemberPayload[] = body.members

  if (!Array.isArray(members) || members.length === 0) {
    return NextResponse.json({ error: 'At least one member is required.' }, { status: 400 })
  }

  // 3. Validate each member
  for (const m of members) {
    if (!m.member_type || !['individual', 'company'].includes(m.member_type)) {
      return NextResponse.json({ error: 'Each member must have a valid type (individual or company).' }, { status: 400 })
    }
    if (m.member_type === 'individual' && !m.full_name?.trim()) {
      return NextResponse.json({ error: 'Individual members must have a full name.' }, { status: 400 })
    }
    if (m.member_type === 'company' && !m.company_name?.trim()) {
      return NextResponse.json({ error: 'Company members must have a company name.' }, { status: 400 })
    }
    const pct = parseFloat(String(m.ownership_pct || 0))
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      return NextResponse.json({ error: 'Each member must have a valid ownership percentage (1–100).' }, { status: 400 })
    }
  }

  // 4. Validate total ownership = 100%
  const total = members.reduce((sum, m) => sum + parseFloat(String(m.ownership_pct || 0)), 0)
  if (Math.abs(total - 100) > 0.01) {
    return NextResponse.json(
      { error: `Ownership percentages must total 100%. Current total: ${total.toFixed(2)}%.` },
      { status: 400 },
    )
  }

  // 4b. Validate exactly one SS-4 signer
  const signerCount = members.filter(m => m.is_signer === true).length
  if (signerCount !== 1) {
    return NextResponse.json(
      { error: 'Please select exactly one member as the SS-4 Responsible Party.' },
      { status: 400 },
    )
  }

  const now = new Date().toISOString()
  const accountId = request.account_id
  const companyName = request.company_name

  // 5. Delete existing members for this account, then insert new
  const { error: deleteErr } = await supabaseAdmin
    .from('members')
    .delete()
    .eq('account_id', accountId)

  if (deleteErr) {
    return NextResponse.json({ error: `Failed to clear existing members: ${deleteErr.message}` }, { status: 500 })
  }

  const insertRows = members.map((m, idx) => ({
    account_id: accountId,
    member_type: m.member_type,
    full_name: m.full_name?.trim() || null,
    company_name: m.company_name?.trim() || null,
    ein: m.ein?.trim() || null,
    email: m.email?.trim() || null,
    phone: m.phone?.trim() || null,
    ownership_pct: parseFloat(String(m.ownership_pct || 0)),
    is_primary: idx === 0,
    is_signer: m.is_signer === true,
    address_street: m.address_street?.trim() || null,
    address_city: m.address_city?.trim() || null,
    address_state: m.address_state?.trim() || null,
    address_zip: m.address_zip?.trim() || null,
    address_country: m.address_country?.trim() || null,
    representative_name: m.representative_name?.trim() || null,
    representative_email: m.representative_email?.trim() || null,
    representative_phone: m.representative_phone?.trim() || null,
    representative_address_street: m.representative_address_street?.trim() || null,
    representative_address_city: m.representative_address_city?.trim() || null,
    representative_address_state: m.representative_address_state?.trim() || null,
    representative_address_zip: m.representative_address_zip?.trim() || null,
    representative_address_country: m.representative_address_country?.trim() || null,
    created_at: now,
    updated_at: now,
  }))

  const { error: insertErr } = await supabaseAdmin
    .from('members')
    .insert(insertRows)

  if (insertErr) {
    return NextResponse.json({ error: `Failed to save members: ${insertErr.message}` }, { status: 500 })
  }

  // 6. Mark request as submitted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('member_info_requests')
    .update({
      status: 'submitted',
      submitted_data: { members },
      submitted_at: now,
    })
    .eq('id', request.id)

  // 7. Log action
  await supabaseAdmin.from('action_log').insert({
    action_type: 'member_info_submitted',
    table_name: 'member_info_requests',
    record_id: request.id,
    account_id: accountId,
    summary: `Member info form submitted: ${members.length} member(s) applied to account ${accountId}`,
    details: { member_count: members.length, request_id: request.id },
  })

  // 8. Provision contacts + portal access for each member (best-effort, non-blocking)
  provisionMemberPortalAccess({ members, accountId, companyName, now }).catch(err =>
    console.error('[member-info] portal provisioning failed:', err)
  )

  return NextResponse.json({ success: true, member_count: members.length })
}

// ─── Portal Provisioning ───────────────────────────────────────────────────

const ADMIN_SENDER_ID = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'

async function provisionMemberPortalAccess({
  members,
  accountId,
  companyName,
  now,
}: {
  members: MemberPayload[]
  accountId: string
  companyName: string
  now: string
}): Promise<void> {
  for (let idx = 0; idx < members.length; idx++) {
    const m = members[idx]
    const isPrimary = idx === 0

    const personEmail = m.member_type === 'company'
      ? m.representative_email?.trim() || null
      : m.email?.trim() || null
    const personName = m.member_type === 'company'
      ? m.representative_name?.trim() || null
      : m.full_name?.trim() || null

    if (!personEmail || !personName) continue

    try {
      // a. Find or create contact
      const { data: existingContact } = await supabaseAdmin
        .from('contacts')
        .select('id, language')
        .eq('email', personEmail)
        .limit(1)
        .maybeSingle()

      let contactId: string
      let contactLanguage = 'en'

      if (existingContact) {
        contactId = existingContact.id
        contactLanguage = existingContact.language === 'Italian' || existingContact.language === 'it' ? 'it' : 'en'
      } else {
        // eslint-disable-next-line no-restricted-syntax -- member form provisioning; deferred migration per dev_task 7ebb1e0c
        const { data: created, error: createErr } = await supabaseAdmin
          .from('contacts')
          .insert({
            full_name: personName,
            email: personEmail,
            phone: m.member_type === 'company' ? (m.representative_phone?.trim() || null) : (m.phone?.trim() || null),
            address_line1: m.member_type === 'company' ? (m.representative_address_street?.trim() || null) : (m.address_street?.trim() || null),
            address_city: m.member_type === 'company' ? (m.representative_address_city?.trim() || null) : (m.address_city?.trim() || null),
            address_state: m.member_type === 'company' ? (m.representative_address_state?.trim() || null) : (m.address_state?.trim() || null),
            address_zip: m.member_type === 'company' ? (m.representative_address_zip?.trim() || null) : (m.address_zip?.trim() || null),
            address_country: m.member_type === 'company' ? (m.representative_address_country?.trim() || null) : (m.address_country?.trim() || null),
            created_at: now,
            updated_at: now,
          })
          .select('id')
          .single()

        if (createErr || !created) {
          console.error(`[member-info] contact create failed for ${personEmail}:`, createErr?.message)
          continue
        }
        contactId = created.id
      }

      // b. Link to account as Member (upsert — safe if already linked)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await supabaseAdmin.from('account_contacts').upsert(
        { account_id: accountId, contact_id: contactId, role: 'Member' } as any,
        { onConflict: 'account_id,contact_id' },
      )

      // c. Create portal user (idempotent)
      const portalResult = await autoCreatePortalUser({ contactId, accountId, tier: 'active' })

      if (!portalResult.success) {
        console.error(`[member-info] portal user failed for ${personEmail}:`, portalResult.error)
        continue
      }

      if (!portalResult.alreadyExists && portalResult.tempPassword) {
        // d. New user → full welcome email with credentials
        await sendPortalWelcomeEmail({ email: personEmail, fullName: personName, tempPassword: portalResult.tempPassword, language: contactLanguage })
      } else if (portalResult.alreadyExists && !isPrimary) {
        // e. Existing user (non-primary) → portal notification about the new company
        const isItalian = contactLanguage === 'it'
        const msg = isItalian
          ? `Sei stato aggiunto come socio di **${companyName}**. Puoi ora accedere al portale di questa società.`
          : `You've been added as a member of **${companyName}**. You now have access to this company's portal.`

        const { error: chatErr } = await supabaseAdmin.from('portal_messages').insert({
          account_id: accountId,
          contact_id: contactId,
          sender_type: 'admin',
          sender_id: ADMIN_SENDER_ID,
          message: msg,
        })

        if (!chatErr) {
          notifyClientOfAdminMessage({
            account_id: accountId,
            contact_id: contactId,
            messagePreview: isItalian ? `Aggiunto come socio di ${companyName}` : `Added as member of ${companyName}`,
          }).catch(e => console.error('[member-info] notify failed:', e))
        }
      }

      await supabaseAdmin.from('action_log').insert({
        action_type: 'member_portal_provisioned',
        table_name: 'contacts',
        record_id: contactId,
        account_id: accountId,
        summary: `Portal provisioned for ${personName} (${portalResult.alreadyExists ? 'existing' : 'new'} user)`,
        details: { is_primary: isPrimary, already_existed: portalResult.alreadyExists },
      })
    } catch (err) {
      console.error(`[member-info] provisioning error for ${personEmail}:`, err)
    }
  }
}
