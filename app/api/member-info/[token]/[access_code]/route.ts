import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { emitClientChatEvent } from '@/lib/portal/chat-events'
import { refreshSS4 } from '@/lib/operations/ss4-refresh'
import { explainFailure } from '@/lib/errors/explain-failure'
import { firstDuplicateIndividualIdentity } from '@/lib/members/member-identity'
import { resolveMemberContactId } from '@/lib/members/resolve-member-contact'

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
    .select('id, account_id, contact_id, status, company_name')
    .eq('token', token)
    .eq('access_code', access_code)
    .single() as { data: { id: string; account_id: string; contact_id: string | null; status: string; company_name: string } | null; error: unknown }

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
    const pct = parseFloat(String(m.ownership_pct || 0))
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      return NextResponse.json({ error: 'Each member must have a valid ownership percentage (1–100).' }, { status: 400 })
    }
    if (m.member_type === 'individual') {
      if (!m.full_name?.trim()) return NextResponse.json({ error: 'Individual members must have a full name.' }, { status: 400 })
      if (!m.email?.trim()) return NextResponse.json({ error: 'Individual members must have an email.' }, { status: 400 })
      if (!m.phone?.trim()) return NextResponse.json({ error: 'Individual members must have a phone number.' }, { status: 400 })
      if (!m.address_street?.trim()) return NextResponse.json({ error: 'Individual members must have a street address.' }, { status: 400 })
      if (!m.address_city?.trim()) return NextResponse.json({ error: 'Individual members must have a city.' }, { status: 400 })
      if (!m.address_state?.trim()) return NextResponse.json({ error: 'Individual members must have a state.' }, { status: 400 })
      if (!m.address_zip?.trim()) return NextResponse.json({ error: 'Individual members must have a ZIP code.' }, { status: 400 })
      if (!m.address_country?.trim()) return NextResponse.json({ error: 'Individual members must have a country.' }, { status: 400 })
    }
    if (m.member_type === 'company') {
      if (!m.company_name?.trim()) return NextResponse.json({ error: 'Company members must have a company name.' }, { status: 400 })
      if (!m.ein?.trim()) return NextResponse.json({ error: 'Company members must have an EIN.' }, { status: 400 })
      if (!m.address_street?.trim()) return NextResponse.json({ error: 'Company members must have a street address.' }, { status: 400 })
      if (!m.address_city?.trim()) return NextResponse.json({ error: 'Company members must have a city.' }, { status: 400 })
      if (!m.address_state?.trim()) return NextResponse.json({ error: 'Company members must have a state.' }, { status: 400 })
      if (!m.address_zip?.trim()) return NextResponse.json({ error: 'Company members must have a ZIP code.' }, { status: 400 })
      if (!m.address_country?.trim()) return NextResponse.json({ error: 'Company members must have a country.' }, { status: 400 })
      if (!m.representative_name?.trim()) return NextResponse.json({ error: 'Company members must have a representative name.' }, { status: 400 })
      if (!m.representative_email?.trim()) return NextResponse.json({ error: 'Company members must have a representative email.' }, { status: 400 })
      if (!m.representative_phone?.trim()) return NextResponse.json({ error: 'Company members must have a representative phone number.' }, { status: 400 })
      if (!m.representative_address_street?.trim()) return NextResponse.json({ error: 'Company members must have a representative street address.' }, { status: 400 })
      if (!m.representative_address_city?.trim()) return NextResponse.json({ error: 'Company members must have a representative city.' }, { status: 400 })
      if (!m.representative_address_state?.trim()) return NextResponse.json({ error: 'Company members must have a representative state.' }, { status: 400 })
      if (!m.representative_address_zip?.trim()) return NextResponse.json({ error: 'Company members must have a representative ZIP code.' }, { status: 400 })
      if (!m.representative_address_country?.trim()) return NextResponse.json({ error: 'Company members must have a representative country.' }, { status: 400 })
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

  // 4c. Two individual members can SHARE one email (a family LLC), but they
  //     must be distinguishable — the database forbids the same individual
  //     person as a member of one company twice. If two individual members
  //     have the same name AND the same email we cannot tell them apart, so
  //     reject up front with a plain message (before creating any contact),
  //     rather than letting it surface as a raw duplicate-key error at save.
  const duplicateName = firstDuplicateIndividualIdentity(members)
  if (duplicateName) {
    return NextResponse.json(
      {
        error: `Two members have the same name and email (${duplicateName}). Members can share one email address, but each member must have a different name. If two members really do have the same name, please contact us and we'll finish the setup for you.`,
      },
      { status: 400 },
    )
  }

  const now = new Date().toISOString()
  const accountId = request.account_id

  // 5. Provision contacts (find-or-create) BEFORE inserting members,
  //    so we can populate members.contact_id inline. Result is a
  //    parallel array of contact_id (or null) per member.
  const memberContactIds = await provisionMemberContacts({ members, accountId, now })

  // 6. Replace members atomically: submit_member_info() DELETEs existing rows
  //    then INSERTs the new set inside one transaction. If the INSERT fails
  //    (e.g. two 'individual' rows resolve to the same contact_id) the members
  //    DELETE+INSERT rolls back, so the account never ends up memberless.
  //    NOTE: the contact provisioning in step 5 runs BEFORE this and is NOT
  //    part of this transaction — a failure here does not roll those back.
  //    Step 4c prevents the only known trigger for such a failure.
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
    contact_id: memberContactIds[idx],
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: submitErr } = await (supabaseAdmin as any).rpc('submit_member_info', {
    p_account_id: accountId,
    p_members: insertRows,
  })

  if (submitErr) {
    // Translate the raw database failure into a plain-language reason
    // (explainFailure already has friendly wording for the members
    // unique-constraint) instead of leaking Postgres internals to the client.
    const explained = explainFailure(submitErr)
    console.error('[member-info] submit_member_info failed:', explained.technical)
    return NextResponse.json({ error: explained.message }, { status: 500 })
  }

  // 7. Mark request as submitted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('member_info_requests')
    .update({
      status: 'submitted',
      submitted_data: { members },
      submitted_at: now,
    })
    .eq('id', request.id)

  // 8. Log action
  await supabaseAdmin.from('action_log').insert({
    action_type: 'member_info_submitted',
    table_name: 'member_info_requests',
    record_id: request.id,
    account_id: accountId,
    summary: `Member info form submitted: ${members.length} member(s) applied to account ${accountId}`,
    details: {
      member_count: members.length,
      request_id: request.id,
      contacts_provisioned: memberContactIds.filter(Boolean).length,
    },
  })

  // 9. Surface in the staff What's New feed (system chat-event note). Fire-and-
  //    forget: a notification failure must never fail the client's submission.
  try {
    await emitClientChatEvent({
      account_id: accountId,
      // Tag the recipient contact too (stored on the request at creation) so
      // the note is visible on their person-level thread's What's New feed,
      // not only on the account thread (2026-07-06 Prowave LLC fix).
      contact_id: request.contact_id ?? null,
      topic: 'Members',
      message: `The client submitted the member information form — ${members.length} member${members.length === 1 ? '' : 's'} for ${request.company_name || 'this company'}.`,
      source: { table: 'member_info_requests', id: request.id },
      event_kind: 'members_updated',
    })
  } catch (err) {
    console.error('[member-info] What\'s New emit failed (non-fatal):', err)
  }

  // 10. Auto-refresh the account's unsigned SS-4 so it never silently
  //     contradicts the member data the client just submitted (AI Venture Labs
  //     2026-07-02: the SS-4 was generated a day BEFORE this form arrived and
  //     kept the wrong responsible party). refreshSS4 is a no-op when no
  //     unsigned SS-4 exists, is audited via action_log, and notifies the new
  //     signer only if the signer changed on an already-sent SS-4. Best-effort:
  //     a refresh failure must never fail the client's submission.
  try {
    const refresh = await refreshSS4({ account_id: accountId, source: 'member-info-form' })
    if (!refresh.ok && refresh.outcome !== 'no_ss4') {
      console.error(`[member-info] SS-4 auto-refresh ${refresh.outcome}:`, refresh.message)
    }
  } catch (err) {
    console.error('[member-info] SS-4 auto-refresh failed (non-fatal):', err)
  }

  return NextResponse.json({ success: true, member_count: members.length })
}

// ─── Contact Provisioning ──────────────────────────────────────────────────
//
// For each member with an email, find-or-create a contact and link it to
// the account as a Member. Portal access is NOT created — the admin grants
// it manually via the "Send Credentials" button on each contact card.

async function provisionMemberContacts({
  members,
  accountId,
  now,
}: {
  members: MemberPayload[]
  accountId: string
  now: string
}): Promise<(string | null)[]> {
  const contactIds: (string | null)[] = []

  for (const m of members) {
    const personEmail = m.member_type === 'company'
      ? m.representative_email?.trim() || null
      : m.email?.trim() || null
    const personName = m.member_type === 'company'
      ? m.representative_name?.trim() || null
      : m.full_name?.trim() || null

    if (!personEmail || !personName) {
      contactIds.push(null)
      continue
    }

    try {
      // Resolve this member to their own contact by email + name via the shared
      // resolver (same procedure used by the onboarding + formation flows), so
      // two members sharing one email stay distinct people. The address/phone the
      // member just provided refreshes the matched (or newly-created) contact.
      const personPhone = m.member_type === 'company' ? (m.representative_phone?.trim() || null) : (m.phone?.trim() || null)
      const contactId = await resolveMemberContactId({
        email: personEmail,
        name: personName,
        now,
        refresh: {
          phone: personPhone,
          address_line1: m.member_type === 'company' ? (m.representative_address_street?.trim() || null) : (m.address_street?.trim() || null),
          address_city: m.member_type === 'company' ? (m.representative_address_city?.trim() || null) : (m.address_city?.trim() || null),
          address_state: m.member_type === 'company' ? (m.representative_address_state?.trim() || null) : (m.address_state?.trim() || null),
          address_zip: m.member_type === 'company' ? (m.representative_address_zip?.trim() || null) : (m.address_zip?.trim() || null),
          address_country: m.member_type === 'company' ? (m.representative_address_country?.trim() || null) : (m.address_country?.trim() || null),
        },
      })

      if (!contactId) {
        contactIds.push(null)
        continue
      }

      // Link to account as Member (upsert — safe if already linked)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await supabaseAdmin.from('account_contacts').upsert(
        { account_id: accountId, contact_id: contactId, role: 'Member' } as any,
        { onConflict: 'account_id,contact_id' },
      )

      contactIds.push(contactId)
    } catch (err) {
      console.error(`[member-info] contact provisioning error for ${personEmail}:`, err)
      contactIds.push(null)
    }
  }

  return contactIds
}
