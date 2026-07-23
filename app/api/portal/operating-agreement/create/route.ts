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
import { APP_BASE_URL } from '@/lib/config'
import { notifyClientActionRequired } from '@/lib/portal/action-required'
import { reportSystemError } from '@/lib/system-errors'

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

    // REFUSE if a co-signer has ALREADY SIGNED this agreement. The delete below
    // removes their signature with it, so regenerating would silently un-sign
    // someone. That has to be a deliberate act with a human in the loop, not a
    // side effect of clicking the button again.
    //
    // A VOIDED agreement is exempt. Voiding is exactly how staff unblock a stuck
    // client, and the portal then tells them "this is outdated — generate a new
    // one" (see the sign page). Counting the dead signatures on a voided record
    // would refuse the very regeneration the void exists to enable, leaving the
    // client told to do something the system won't allow. Its signatures are
    // already legally dead.
    if (existing.status !== 'voided') {
      const { count: signedCount, error: countErr } = await supabaseAdmin
        .from('oa_signatures')
        .select('id', { count: 'exact', head: true })
        .eq('oa_id', existing.id)
        .eq('status', 'signed')

      // FAIL CLOSED. Discarding this error meant a transient database problem
      // returned a null count, which read as "nobody signed" — so the one guard
      // protecting an executed signature did nothing precisely when the database
      // was unhealthy, and the delete below destroyed the signature anyway.
      if (countErr || signedCount === null) {
        return NextResponse.json({
          error: 'Could not verify the signing status of the existing Operating Agreement. Please try again in a moment, or contact support.',
        }, { status: 503 })
      }

      if (signedCount > 0) {
        return NextResponse.json({
          error: `Cannot regenerate — ${signedCount} member${signedCount === 1 ? ' has' : 's have'} already signed this Operating Agreement. Contact support to have it reissued.`,
        }, { status: 409 })
      }
    }

    // Delete UNSIGNED signature rows only, and prove none were signed after.
    //
    // The count check above is a read, and this is a separate round trip: a
    // co-signer submitting in the gap between them would have their signature
    // destroyed by the unconditional delete that used to be here. Excluding
    // signed rows from the delete means the race can no longer destroy one; the
    // re-count then catches the case and refuses, leaving both the signature and
    // the agreement intact rather than half-removed. (Same guard-on-write shape
    // the codebase mandates elsewhere for exactly this class.)
    await supabaseAdmin
      .from('oa_signatures')
      .delete()
      .eq('oa_id', existing.id)
      .neq('status', 'signed')

    const { count: survivors, error: survivorErr } = await supabaseAdmin
      .from('oa_signatures')
      .select('id', { count: 'exact', head: true })
      .eq('oa_id', existing.id)

    if (survivorErr || survivors === null) {
      return NextResponse.json({
        error: 'Could not verify the signing status of the existing Operating Agreement. Please try again in a moment, or contact support.',
      }, { status: 503 })
    }
    if (survivors > 0) {
      // Someone signed while we were working. Their signature survived the
      // delete; leave the agreement standing with it.
      return NextResponse.json({
        error: `Cannot regenerate — a member signed this Operating Agreement while it was being replaced. Contact support to have it reissued.`,
      }, { status: 409 })
    }

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
  const notifyOutcomes: Awaited<ReturnType<typeof notifyClientActionRequired>>[] = []
  // Is the person who just pressed the button themselves a signer? For a
  // single-member company they always are. For a multi-member one the creator
  // may be an administrator who is not among the members — offering them a
  // "Sign now" button lands them on a read-only page with nothing to click.
  let callerCanSign = !isMMLC

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
      // ROLL BACK. The agreement row is already committed as 'sent', and with no
      // signature rows NOBODY can sign it: the sign page finds no signer for any
      // member and shows a read-only view, while the reminder tells every member
      // their signature is needed — permanently. Leaving it was survivable when
      // the row was born 'draft' and therefore invisible; now that it is 'sent'
      // and visible, a half-built agreement is worse than none.
      console.error('OA signatures insert failed:', sigErr.message)
      await supabaseAdmin.from('oa_signatures').delete().eq('oa_id', oa.id)
      await supabaseAdmin.from('oa_agreements').delete().eq('id', oa.id)
      await reportSystemError({
        source: 'server',
        route: '/api/portal/operating-agreement/create',
        method: 'POST',
        message: `Operating Agreement for ${account.company_name} rolled back — signature rows could not be created`,
        context: { account_id, token, members: membersRows.length, db_error: sigErr.message },
      })
      return NextResponse.json({
        error: 'Could not set up the signature records for this Operating Agreement. Nothing was created — please try again, or contact support.',
      }, { status: 500 })
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
        if (sig.contact_id === contactId) callerCanSign = true
        // The co-signer's DIRECT signing link — EMAIL ONLY.
        //
        // A member is identified by a row in the members table and need not be
        // linked to the company as a portal user, so a portal-relative link can
        // resolve to the wrong company or to nothing for them. This one needs no
        // login and identifies them specifically.
        //
        // But it CARRIES THEIR SIGNING CODE — the credential that authorises
        // signing as them — so it must never touch an account-scoped channel.
        // The portal chat thread and the bell list are both readable by every
        // linked contact on the company, so putting it there would hand member B
        // the ability to sign as member A. Email is per-recipient; that is the
        // only safe place for it. Chat and bell get the plain portal path below.
        const signerUrl = `${APP_BASE_URL}/operating-agreement/${oa.token}/${oa.access_code}?portal=true&signer=${sig.access_code}`
        const r = await notifyClientActionRequired({
          contact_id: sig.contact_id,
          account_id,
          topic: 'Operating Agreement',
          title: {
            // Name the company. A client with more than one LLC gets one of
            // these per company; an unqualified subject leaves them unable to
            // tell which is which.
            en: `Sign the Operating Agreement for ${account.company_name}`,
            it: `Firma l'Atto Costitutivo di ${account.company_name}`,
          },
          message: {
            en: `The Operating Agreement for ${account.company_name} is ready for your signature. All ${totalSigners} members must sign before it takes effect.`,
            it: `L'Atto Costitutivo di ${account.company_name} è pronto per la tua firma. Tutti i ${totalSigners} soci devono firmare prima che diventi efficace.`,
          },
          // The agreement id is in the link so the DEDUP SCOPE changes whenever
          // the agreement does. Without it, a client regenerating within the
          // 10-minute window had the replacement suppressed on every channel —
          // including the email that carries the only working link — while the
          // old agreement had just been deleted and its codes regenerated. The
          // co-signer was left holding a dead link and the screen said everyone
          // had been notified. The id is not a credential: it is already
          // readable by anyone with the anon key.
          link: `/portal/sign/oa?account=${account_id}&oa=${oa.id}`,
          emailLink: signerUrl,
        })
        notifyOutcomes.push(r)
      }
    }
  } else {
    // ── SMLLC: NOTIFY THE SOLE SIGNER ──
    // The sole member IS the person who just created it, so this is a reminder
    // rather than an announcement — but it still has to exist: the create screen
    // ends on "Signing process started!" with only a "Generate another" button,
    // and the agreement previously never reached the action-required list.
    notifyOutcomes.push(await notifyClientActionRequired({
      contact_id: contactId,
      account_id,
      topic: 'Operating Agreement',
      title: {
        en: `Sign the Operating Agreement for ${account.company_name}`,
        it: `Firma l'Atto Costitutivo di ${account.company_name}`,
      },
      message: {
        en: `The Operating Agreement for ${account.company_name} is ready for your signature.`,
        it: `L'Atto Costitutivo di ${account.company_name} è pronto per la tua firma.`,
      },
      // Agreement id in the link — same reason as the multi-member branch: the
      // dedup scope has to change when the agreement is replaced.
      link: `/portal/sign/oa?account=${account_id}&oa=${oa.id}`,
    }))
  }

  // Report honestly whether the client was actually told. The helper never
  // throws — a dead Gmail token yields "0 sent" — so without this the create
  // screen shows a green "Signing process started!" while nobody was notified:
  // the same silent-success failure this whole change exists to remove.
  // A duplicate-suppressed dispatch COUNTS AS NOTIFIED. The client regenerating
  // within the 10-minute window was already told a minute ago, and the link is
  // per-company so it still resolves to the new agreement. Treating that as a
  // failure raised a false "nobody was notified" alarm on every legitimate
  // regenerate — caught in end-to-end QA, not by reading this code.
  const reached = (channel: string) =>
    channel.startsWith('ok') || channel.startsWith('skipped: duplicate')
  // EVERY recipient, not just one. With `some`, a three-member company where two
  // dispatches failed still read as success — no alarm, and the screen told the
  // creator that every member had received their link.
  //
  // And for a MULTI-MEMBER agreement the EMAIL specifically must land: chat and
  // the bell deliberately carry only a plain portal path (the working per-member
  // link is a credential, so it is email-only), and a co-signer need not be a
  // portal user at all. "Chat succeeded" tells us nothing about whether that
  // person can reach the document. For a single-member agreement the signer is
  // the person on the screen, who has the Sign-now button in front of them, so
  // either channel is genuine.
  const notified = notifyOutcomes.length > 0 && notifyOutcomes.every(r =>
    isMMLC ? reached(r.email) : (reached(r.chat) || reached(r.email)))
  // NOT gated on "we tried at least once". Zero attempts is the WORST case, not
  // an exempt one: if the signature rows fail to insert, the notify loop never
  // runs, and gating on length > 0 meant that silence raised no alarm at all —
  // an agreement marked sent, nobody told, nobody warned. Exactly the incident
  // this change exists to prevent.
  if (!notified) {
    await reportSystemError({
      source: 'server',
      route: '/api/portal/operating-agreement/create',
      method: 'POST',
      // Say WHICH case it is. "NO signer could be notified" was written when the
      // check required only one recipient; now that every signer must be reached
      // — and a co-signer must be reached BY EMAIL — the common trigger is one
      // member out of several, and that wording sends whoever reads the alarm
      // looking for a total outage that did not happen.
      message: notifyOutcomes.length === 0
        ? `Operating Agreement created for ${account.company_name} but NO notification was even attempted (signature rows missing?)`
        : `Operating Agreement created for ${account.company_name} but ${notifyOutcomes.filter(r => !(isMMLC ? reached(r.email) : (reached(r.chat) || reached(r.email)))).length} of ${notifyOutcomes.length} signer(s) could not be reached${isMMLC ? ' by email — a co-signer cannot sign without it' : ''}`,
      context: {
        account_id,
        token: oa.token,
        entity_type: entityType,
        total_signers: totalSigners,
        dispatches_attempted: notifyOutcomes.length,
        outcomes: notifyOutcomes.map(r => ({ chat: r.chat, email: r.email, notification: r.notification })),
      },
    })
  }

  return NextResponse.json({
    success: true,
    notified,
    canSignNow: callerCanSign,
    token: oa.token,
    total_signers: totalSigners,
  })
}
