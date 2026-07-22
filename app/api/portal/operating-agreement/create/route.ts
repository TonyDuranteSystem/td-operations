/**
 * POST /api/portal/operating-agreement/create
 *
 * Portal self-service OA creation. Called by the Generate Documents client
 * when the primary contact clicks "Create & Send for Signing".
 *
 * Flow:
 * 1. Authenticate portal user + verify account access
 * 2. Fetch account details + members table rows
 * 3. Silently replace any existing unsigned OA
 * 4. Insert oa_agreements with correct entity_type + total_signers + members JSON
 * 5. For MMLLC: insert oa_signatures (one per member) + notify EVERY member
 * 6. For SMLLC: notify the sole signer
 *
 * Notification is the shared action-required dispatch (portal chat + immediate
 * bilingual email + bell + push), pointing at the Sign section. The agreement is
 * stored as 'sent', not 'draft', or it never reaches the portal's action-required
 * list — see the comment on the status field.
 *
 * Body: { account_id: string, effective_date: string, member_addresses: string[] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { notifyClientActionRequired } from '@/lib/portal/action-required'

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked to your account' }, { status: 403 })

  let body: { account_id?: string; effective_date?: string; member_addresses?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { account_id, effective_date, member_addresses = [] } = body
  if (!account_id || !effective_date) {
    return NextResponse.json({ error: 'account_id and effective_date are required' }, { status: 400 })
  }

  // Verify the logged-in contact has access to this account
  const accessibleIds = await getClientAccountIds(contactId)
  if (!accessibleIds.includes(account_id)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // ── 1. FETCH ACCOUNT DETAILS ──
  const { data: account } = await (supabaseAdmin as any)
    .from('accounts')
    .select('id, company_name, entity_type, member_structure, state_of_formation, formation_date, ein_number, registered_agent_provider, registered_agent_address, physical_address, member_count')
    .eq('id', account_id)
    .single()

  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  // The DB stores "Multi Member LLC" (long form) — normalize before comparing,
  // and let member_structure catch entity types the normalizer passes through
  // (e.g. a multi-member "C-Corp Elected" LLC).
  const isMMLC = normalizeEntityType(account.entity_type as string | null) === 'MMLLC'
    || account.member_structure === 'multi_member'
  const entityType = isMMLC ? 'MMLLC' : 'SMLLC'

  // ── 2. FETCH MEMBERS (MMLLC only) ──
  let membersRows: Array<{
    id: string
    full_name: string | null
    company_name: string | null
    email: string | null
    ownership_pct: number | null
    is_primary: boolean | null
    contact_id: string | null
    member_type: string
    address_street: string | null
    address_city: string | null
    address_state: string | null
    address_zip: string | null
    address_country: string | null
  }> = []

  if (isMMLC) {
    const { data: rows } = await supabaseAdmin
      .from('members')
      .select('id, full_name, company_name, email, ownership_pct, is_primary, contact_id, member_type, address_street, address_city, address_state, address_zip, address_country')
      .eq('account_id', account_id)
      .order('is_primary', { ascending: false })

    membersRows = rows ?? []

    if (membersRows.length === 0) {
      return NextResponse.json({ error: 'No members found for this MMLLC — add members in the CRM first' }, { status: 422 })
    }

    // MMLLC validation: all members must have contact_id to sign
    const missingPortal = membersRows.filter(m => !m.contact_id).map(m => m.full_name ?? m.company_name ?? 'Unknown')
    if (missingPortal.length > 0) {
      return NextResponse.json({
        error: `Cannot create OA — ${missingPortal.join(', ')} ${missingPortal.length === 1 ? 'has' : 'have'} no portal account. Contact support to invite them.`,
      }, { status: 422 })
    }

    // Ownership must be complete and total 100% — an OA with wrong percentages
    // is a legally incorrect document, so fail loud instead of generating it.
    const ownershipTotal = membersRows.reduce((s, m) => s + (Number(m.ownership_pct) || 0), 0)
    if (Math.abs(ownershipTotal - 100) > 0.01) {
      return NextResponse.json({
        error: `Cannot create OA — member ownership percentages total ${ownershipTotal}% instead of 100%. Contact support to correct the member records.`,
      }, { status: 422 })
    }
  }

  // ── 3. FETCH PRIMARY CONTACT ──
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('full_name, email')
    .eq('id', contactId)
    .single()

  if (!contact) return NextResponse.json({ error: 'Primary contact not found' }, { status: 404 })

  // ── 4. BUILD TOKEN ──
  const companySlug = (account.company_name as string)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const year = new Date().getFullYear()
  const token = `${companySlug}-oa-${year}`

  // ── 5. SILENTLY REPLACE UNSIGNED OA ──
  const { data: existingOAs } = await supabaseAdmin
    .from('oa_agreements')
    .select('id, status')
    .eq('account_id', account_id)
    .order('created_at', { ascending: false })
    .limit(1)

  if (existingOAs && existingOAs.length > 0) {
    const existing = existingOAs[0]
    if (existing.status === 'signed') {
      return NextResponse.json({ error: 'This company already has a signed Operating Agreement. Contact support if you need a new one.' }, { status: 409 })
    }
    // Delete existing unsigned OA + signatures
    await supabaseAdmin.from('oa_signatures').delete().eq('oa_id', existing.id)
    await supabaseAdmin.from('oa_agreements').delete().eq('id', existing.id)
  }

  // ── 6. BUILD MEMBERS JSON FOR MMLLC ──
  // Address priority: CRM members row → caller-provided member_addresses[i].
  const composeMemberAddress = (m: (typeof membersRows)[number]): string | null => {
    const parts = [m.address_street, m.address_city, m.address_state, m.address_zip, m.address_country].filter(Boolean)
    return parts.length > 0 ? parts.join(', ') : null
  }
  const totalSigners = isMMLC ? membersRows.length : 1
  const membersJson = isMMLC
    ? membersRows.map((m, i) => ({
        name: m.full_name ?? m.company_name ?? 'Unknown',
        address: composeMemberAddress(m) ?? member_addresses[i] ?? null,
        email: m.email ?? null,
        ownership_pct: m.ownership_pct ?? 0,
        initial_contribution: '$1,000 USD',
      }))
    : null

  // ── 7. INSERT OA_AGREEMENTS ──
  const primaryMember = isMMLC ? membersRows[0] : null
  const { data: oa, error: insertErr } = await supabaseAdmin
    .from('oa_agreements')
    .insert({
      token,
      account_id,
      contact_id: contactId,
      company_name: account.company_name,
      state_of_formation: account.state_of_formation ?? null,
      formation_date: account.formation_date ?? null,
      ein_number: account.ein_number ?? null,
      entity_type: entityType,
      manager_name: contact.full_name,
      member_name: isMMLC ? (primaryMember?.full_name ?? contact.full_name) : contact.full_name,
      member_address: member_addresses[0] ?? null,
      member_email: isMMLC ? (primaryMember?.email ?? contact.email) : contact.email,
      members: membersJson,
      effective_date: effective_date,
      business_purpose: 'any and all lawful business activities',
      initial_contribution: '$1,000 USD',
      fiscal_year_end: 'December 31',
      accounting_method: 'Cash',
      duration: 'Perpetual',
      registered_agent_name: account.registered_agent_provider ?? null,
      registered_agent_address: account.registered_agent_address ?? null,
      principal_address: account.physical_address ?? '10225 Ulmerton Rd, Suite 3D, Largo, FL 33771',
      language: 'en',
      // 'sent', NOT 'draft'. This route IS the send — the client built the
      // agreement and is notified in the same breath. Stored as 'draft' it was
      // invisible to the portal's "action required" list, which matches only
      // sent / viewed / awaiting_signature / partially_signed. So a client who
      // generated their own agreement was never reminded to sign it, and the
      // chat message told them to "go to the Sign section" where nothing
      // prompted them. (Lorenzo Cassi, 2026-07-22: created it, saw a success
      // screen, then asked "dove firmo?" — three other live clients are stuck
      // the same way.) The CRM send path has always written 'sent' here, which
      // is why this only ever bit self-service clients.
      status: 'sent',
      total_signers: totalSigners,
      signed_count: 0,
    })
    .select('id, token, access_code')
    .single()

  if (insertErr || !oa) {
    return NextResponse.json({ error: insertErr?.message ?? 'Failed to create OA' }, { status: 500 })
  }

  // ── 8. FOR MMLLC: INSERT OA_SIGNATURES + SEND PORTAL CHAT ──
  if (isMMLC) {
    const sigRows = membersRows.map((m, idx) => ({
      oa_id: oa.id,
      member_index: idx,
      member_name: m.full_name ?? m.company_name ?? 'Unknown',
      member_email: m.email ?? null,
      contact_id: m.contact_id,
    }))

    const { data: insertedSigs, error: sigErr } = await supabaseAdmin
      .from('oa_signatures')
      .insert(sigRows)
      .select('member_index, member_name, contact_id, access_code')

    if (sigErr) {
      // OA was created — partial failure, don't block
      console.error('OA signatures insert failed:', sigErr.message)
    } else if (insertedSigs) {
      // Notify EVERY member: portal chat + immediate email + bell + push, each
      // in their own language. Previously this inserted a chat message only —
      // a member who did not open the portal had no idea they were holding up
      // the agreement. The shared helper is the same one the SS-4 flow uses
      // (born from a client who had to ask why nothing happened), and it points
      // at the Sign section, where /portal/sign/oa resolves each member's own
      // signature row from their contact — so every member gets THEIR link, not
      // the primary signer's.
      for (const sig of insertedSigs) {
        if (!sig.contact_id) continue
        await notifyClientActionRequired({
          contact_id: sig.contact_id,
          account_id,
          topic: 'Operating Agreement',
          title: {
            en: 'Sign your Operating Agreement',
            it: 'Firma il tuo Atto Costitutivo',
          },
          message: {
            en: `The Operating Agreement for ${account.company_name} is ready for your signature. All ${totalSigners} members must sign before it takes effect.`,
            it: `L'Atto Costitutivo di ${account.company_name} è pronto per la tua firma. Tutti i ${totalSigners} soci devono firmare prima che diventi efficace.`,
          },
          link: '/portal/sign/oa',
        })
      }
    }
  } else {
    // ── SMLLC: NOTIFY THE SOLE SIGNER ──
    // The sole member IS the person who just created it, so this is a reminder
    // rather than an announcement — but it still has to exist: the create screen
    // ends on "Signing process started!" with only a "Generate another" button,
    // and the agreement previously never reached the action-required list.
    await notifyClientActionRequired({
      contact_id: contactId,
      account_id,
      topic: 'Operating Agreement',
      title: {
        en: 'Sign your Operating Agreement',
        it: 'Firma il tuo Atto Costitutivo',
      },
      message: {
        en: `The Operating Agreement for ${account.company_name} is ready for your signature.`,
        it: `L'Atto Costitutivo di ${account.company_name} è pronto per la tua firma.`,
      },
      link: '/portal/sign/oa',
    })
  }

  return NextResponse.json({
    success: true,
    token: oa.token,
    total_signers: totalSigners,
  })
}
