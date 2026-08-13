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
 * Body: { account_id: string, effective_date: string }
 *
 * ⛔ `member_addresses: string[]` IS GONE — do not reintroduce it (dev job
 * `61f184ca`, Antonio's ruling 2026-08-12: "A legal document must never be able to
 * disagree with the system of record").
 *
 * It was a client-typed address per member, position-matched to a SEPARATE members
 * query, and carried two defects that were only ever held off by discipline:
 *   1. Whenever the member row had an address — i.e. always, for every company
 *      member in production — the typed value was silently discarded. The field
 *      looked editable and was not, so a client correcting a wrong address had no
 *      way to succeed and no way to know they had failed.
 *   2. The array was indexed against a query ordered only by `is_primary`, so with
 *      three members and one primary the two non-primary rows could come back in a
 *      different relative order than the browser used — pairing a typed address
 *      with a DIFFERENT member, in a legal document.
 * Deleting the path removes both by construction. The screen is now read-only and
 * renders exactly what this route stores, via the shared resolver.
 *
 * NO ADDRESS FIELD OF ANY KIND is accepted. A sole owner could briefly type one
 * (their company has no member roster by design), which meant prefilling a form by
 * SPLITTING a stored one-line address back apart. That join is lossy — 35 of 271
 * contacts have fewer than five parts — so the split guessed wrong and the guess
 * was written back over the client's contact record, erasing city, state, postal
 * code and country. Antonio removed the field and the write-back entirely rather
 * than repair the splitter: the record wins everywhere, with no carve-out. A sole
 * owner corrects their address on their PROFILE screen, which already offers the
 * five structured fields and a safe write.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { hasCollectedSignatures } from '@/lib/portal/oa-regenerate-guard'
import { OA_SUPPORTED_STATES, normalizeOAState } from '@/lib/types/oa-templates'
import { APP_BASE_URL } from '@/lib/config'
import { notifyClientActionRequired } from '@/lib/portal/action-required'
import { reportSystemError } from '@/lib/system-errors'
import { resolveSigningSet, describeSigningBlock, signerDisplayName, type ResolvedSigner } from '@/lib/members/signing-set'
import {
  mustRefuseSuppliedAddress,
  mustRefuseOnMemberReadFailure,
  resolveSoleMemberAddress,
  pickSoleMemberRow,
  formatOwnerContactAddress,
  shouldStoreSoleMemberAddress,
} from '@/lib/members/oa-address-decisions'
import { formatMemberAddressRow } from '@/lib/members/member-address'
import { resolveOwnerOfRecord, resolveOwnerName } from '@/lib/members/sole-owner-address'
import { signerLinkExpiryISO } from '@/lib/oa/public-view'

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked to your account' }, { status: 403 })

  let body: {
    account_id?: string
    effective_date?: string
    // No address field of any kind. See mustRefuseSuppliedAddress below.
    [key: string]: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { account_id, effective_date } = body

  // NOTHING on the Generate Documents screen is editable, so no request may carry
  // an address. Refused LOUDLY rather than ignored: the deleted editable field was
  // silently discarded for every account that had member records, which meant a
  // client correcting a wrong address had no way to succeed and no way to know they
  // had failed. A stale client or a crafted post gets told, not humoured.
  if (mustRefuseSuppliedAddress(body as Record<string, unknown>)) {
    return NextResponse.json({
      // The ONLY realistic sender is a browser tab or cached app shell still
      // running the PREVIOUS build, which posted an address on every generate. That
      // client has done nothing wrong and their address is fine — telling them to
      // contact support would send us mail about a problem a refresh fixes.
      error: 'This page is out of date — please refresh and try again.',
    }, { status: 400 })
  }

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

  // Both STAFF doors refuse an unsupported state; this client-facing one did not.
  // The templates only carry state-specific clauses (charging-order protection,
  // annual-report duty, governing law) for the supported states — outside them a
  // client would silently self-generate a materially weaker agreement that staff
  // would have been blocked from producing.
  // MUST normalise first: accounts store the full name ("Wyoming", "New
  // Mexico"), not the code. Comparing the stored value straight against the code
  // list refused 289 of 291 production accounts.
  const oaState = normalizeOAState(account.state_of_formation)
  if (!OA_SUPPORTED_STATES.includes(oaState as (typeof OA_SUPPORTED_STATES)[number])) {
    return NextResponse.json(
      {
        error: `We can't generate an Operating Agreement for ${account.state_of_formation || 'this state'} automatically yet. Please contact support@tonydurante.us and we'll prepare it for you.`,
      },
      { status: 400 },
    )
  }

  // The DB stores "Multi Member LLC" (long form) — normalize before comparing,
  // and let member_structure catch entity types the normalizer passes through
  // (e.g. a multi-member "C-Corp Elected" LLC).
  const isMMLC = normalizeEntityType(account.entity_type as string | null) === 'MMLLC'
    || account.member_structure === 'multi_member'
  const entityType = isMMLC ? 'MMLLC' : 'SMLLC'

  // ── 2. FETCH MEMBERS ──
  // Now fetched for SINGLE-member agreements too, not just multi-member ones.
  // A single-member OA used to take its member address purely from what the
  // client typed on screen, which is the free-typing path this change deletes:
  // where a member row exists it is the system of record for BOTH entity types,
  // and the screen renders it read-only. The row is still the only source for
  // `oaSigners` below — who gets sent a signature request is a different
  // question from who is on the roster (an individual with no email is a member
  // but cannot be asked to sign; a company member signs through its
  // representative), and that stays multi-member-only.
  let oaSigners: ResolvedSigner[] = []
  let membersRows: Array<{
    id: string
    full_name: string | null
    company_name: string | null
    email: string | null
    ownership_pct: number | null
    is_primary: boolean | null
    contact_id: string | null
    member_type: string
    representative_name: string | null
    representative_email: string | null
    address_street: string | null
    address_city: string | null
    address_state: string | null
    address_zip: string | null
    address_country: string | null
  }> = []

  const { data: rows, error: membersErr } = await supabaseAdmin
    .from('members')
    .select('id, full_name, company_name, email, ownership_pct, is_primary, contact_id, member_type, representative_name, representative_email, address_street, address_city, address_state, address_zip, address_country')
    .eq('account_id', account_id)
    .order('is_primary', { ascending: false })

  // FAIL CLOSED. Discarding this error is not a missing nicety — it silently
  // decides WHO IS AUTHORITATIVE. `rows` is null on failure, which is
  // indistinguishable from "this company has no member records", and TWO things
  // now hang off that distinction: the member address that goes into the
  // agreement, and which record it comes from. So a transient database failure (or
  // a typo in the select list above) would store a single-member agreement with NO
  // address, printing "As on file with the Company" behind a green success screen —
  // and, if the same failure hit the page render, the screen would show the same
  // emptiness, so both surfaces would be wrong in the same direction and look
  // perfectly consistent.
  //
  // Refusing costs a client one retry. The alternative is a wrong legal
  // document that nobody is told about. Same reasoning, and the same shape, as
  // the signature-count guard further down this file.
  if (mustRefuseOnMemberReadFailure(membersErr)) {
    await reportSystemError({
      source: 'server',
      route: '/api/portal/operating-agreement/create',
      method: 'POST',
      http_status: 503,
      message: `Operating Agreement for ${account.company_name} refused — the member records could not be read, so the agreement's member addresses could not be trusted`,
      context: { account_id, db_error: membersErr.message },
    })
    return NextResponse.json({
      error: 'We could not read this company\'s member details just now, so we have not created the agreement. Please try again in a moment — if it keeps happening, send us a message.',
    }, { status: 503 })
  }

  membersRows = rows ?? []

  // A Single Member LLC has NO member roster by design — an empty result here is
  // CORRECT state, not a gap. (The read failure that would be indistinguishable
  // from it is refused above.) For those companies the address of record lives on
  // the owner's contact instead; nobody may supply one from the browser.
  const hasMemberRecords = membersRows.length > 0

  // WHO OWNS THIS ADDRESS. Re-derived here from the account's own links, NOT taken
  // from the caller and NOT trusted from the browser: this decides the NAME and the
  // ADDRESS on the document, so letting the logged-in identity stand in for it would
  // let a co-owner or administrator shift whose details the agreement carries
  // (Antonio, 2026-08-12: "the document follows the OWNER of record, never whoever
  // is signed in"). Same helper and same query shape as the screen, so the two
  // cannot resolve different people.
  let ownerOfRecordContactId: string | null = null
  let ownerRecordAddress: string | null = null
  let ownerName: string | null = null
  let ownerEmail: string | null = null
  if (!hasMemberRecords) {
    const { data: links, error: linksErr } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id, role')
      .eq('account_id', account_id)
      // Ordered, and NOT limited — the screen runs the same query to resolve the
      // same owner, and the two must never see a different link set.
      .order('contact_id', { ascending: true })

    // Fail closed for the same reason the members read does: an unreadable link
    // list is indistinguishable from "you are not the owner", and guessing either
    // way either blocks the real owner or lets the wrong person author an address.
    if (linksErr) {
      await reportSystemError({
        source: 'server',
        route: '/api/portal/operating-agreement/create',
        method: 'POST',
        http_status: 503,
        message: `Operating Agreement for ${account.company_name} refused — the account's contact links could not be read, so the owner of record could not be established`,
        context: { account_id, db_error: linksErr.message },
      })
      return NextResponse.json({
        error: 'We could not confirm this company\'s owner just now, so we have not created the agreement. Please try again in a moment — if it keeps happening, send us a message.',
      }, { status: 503 })
    }

    // SAME helper the screen uses, so the two cannot reach different owners.
    const ownerResolution = resolveOwnerOfRecord(links ?? [])

    // REFUSE rather than guess. The screen blocks generation on the identical
    // resolution, so the two agree; the version that returned null instead let the
    // screen render a member called "N/A" while this route stored the LOGGED-IN
    // person's name — the previewed and the signed document disagreeing about who
    // owns the company, which is the defect this whole job exists to remove.
    // (A company with exactly ONE linked person needs no role at all — the helper
    // treats that as unambiguous, which is why this refuses almost nobody: 218 of
    // 225 rosterless accounts match an owner role, 4 more match member-ish, and the
    // only 3 with no match have no contacts to name.)
    if (!ownerResolution.resolved) {
      return NextResponse.json({
        error: ownerResolution.reason === 'no_contacts'
          // Portal wording, no email: the form and the correction both reach the
          // client IN THEIR PORTAL, and client-facing copy must never say otherwise
          // (Antonio, 2026-08-12).
          ? 'We don\'t have anyone on file as the owner of this company yet, so we can\'t put a name on the Operating Agreement. Send us a message and we\'ll set it up.'
          : ownerResolution.reason === 'several_owners'
            ? 'More than one person on this company is listed as an owner, so we can\'t say who should be named as the member on the Operating Agreement. Send us a message and we\'ll set it straight.'
            : 'Your company has several people linked to it and none is marked as the owner, so we can\'t say whose name and address belong on the Operating Agreement. Send us a message and we\'ll set it straight.',
      }, { status: 422 })
    }

    ownerOfRecordContactId = ownerResolution.contactId

    // The owner's NAME, ADDRESS and EMAIL — read here, BEFORE section 5 deletes any
    // existing agreement. An earlier version refused further down, after the
    // delete: the client lost the agreement they had, got nothing back, and was
    // told we held no name for them. Destroying a document and then refusing is
    // worse than the bug this job started with (Antonio, 2026-08-12).
    const { data: ownerContact, error: ownerErr } = await supabaseAdmin
      .from('contacts')
      .select('full_name, first_name, last_name, email, address_line1, address_city, address_state, address_zip, address_country')
      .eq('id', ownerOfRecordContactId)
      .maybeSingle()

    // FAIL CLOSED, like every sibling read in this file. Discarding this error
    // turned a transient database problem into "we don't have a name on file for
    // your owner" — a false statement to the client, with no alarm raised.
    if (ownerErr) {
      await reportSystemError({
        source: 'server',
        route: '/api/portal/operating-agreement/create',
        method: 'POST',
        http_status: 503,
        message: `Operating Agreement for ${account.company_name} refused — the owner's contact record could not be read`,
        context: { account_id, owner_contact_id: ownerOfRecordContactId, db_error: ownerErr.message },
      })
      return NextResponse.json({
        error: 'We could not read the owner\'s details just now, so we have not created the agreement. Please try again in a moment — if it keeps happening, send us a message.',
      }, { status: 503 })
    }

    ownerRecordAddress = formatOwnerContactAddress(ownerContact)
    // The document NAMES the owner, never whoever is holding the mouse. Same helper
    // as the screen, so the previewed and the stored name cannot differ.
    ownerName = resolveOwnerName(ownerContact)
    ownerEmail = ownerContact?.email ?? null

    // No usable name is the same class of failure as no identifiable owner: we
    // cannot say who owns this company. Refuse rather than print a placeholder —
    // and refuse HERE, before anything is deleted.
    if (!ownerName) {
      return NextResponse.json({
        error: 'We don\'t have a name on file for the owner of this company, so we can\'t put one on the Operating Agreement. Send us a message and we\'ll set it up.',
      }, { status: 422 })
    }
  }

  // No submission gate is needed any more: an address on the request was already
  // refused above, for every account shape. What remains is only WHOSE address to
  // display and store, which is the owner-of-record lookup above.

  if (isMMLC) {
    if (membersRows.length === 0) {
      return NextResponse.json({ error: 'No members found for this MMLLC — add members in the CRM first' }, { status: 422 })
    }

    // Being a member and being a SIGNER are different things (Antonio,
    // 2026-08-09) — but a member who cannot sign does not get routed around.
    // "A multi-member operating agreement signed by only one owner must never
    // exist. It is a legal document and it must contain all members. So an
    // agreement can never be issued with fewer signers than members."
    //
    // This replaces BOTH earlier rules: the original "every member needs a
    // contact_id or we refuse" (which refused for the wrong reason — a company
    // member signs through its representative, not a portal account) and the
    // brief "refuse only when NOBODY can sign" (which let a two-member company
    // reach exactly one expected signature and silently disabled every
    // per-member signing gate downstream).
    //
    // Failing here CAN leave a client stuck until someone supplies the missing
    // email. That is the intended failure for a legal document — provided the
    // reason is visible to them and reaches a human, which is what the
    // reportSystemError below is for.
    const signingSet = resolveSigningSet(membersRows)
    oaSigners = signingSet.signers
    const block = describeSigningBlock(signingSet)
    if (block.blocked) {
      await reportSystemError({
        source: 'server',
        route: '/api/portal/operating-agreement/create',
        method: 'POST',
        http_status: 422,
        message: block.staffMessage,
        context: {
          account_id,
          company: account.company_name,
          members_total: membersRows.length,
          signers: signingSet.signers.length,
          blocked_by: block.members.map(m => m.name),
        },
      })
      return NextResponse.json({ error: block.clientMessage }, { status: 422 })
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
  // ALL rows for this account, not just the newest. The token is
  // `<company-slug>-oa-<year>`, so a second row for the same year collides — and
  // the public fetch resolves a token expecting ONE row, so two makes BOTH
  // unreachable: the emailed link, the portal iframe, the Sign-now button and the
  // dashboard reminder all 404. Replacing only the newest left any older sibling
  // in place. That lands hardest on exactly the accounts carrying old drafts —
  // the ones this change is meant to rescue — where before they merely saw an
  // inert row and now five channels point them at a dead page.
  const { data: existingOAs } = await supabaseAdmin
    .from('oa_agreements')
    .select('id, status, signed_count')
    .eq('account_id', account_id)
    .order('created_at', { ascending: false })

  if (existingOAs && existingOAs.length > 0) {
    // Guard against the NEWEST row (the one a client could be mid-signature on);
    // the sweep below then clears every sibling so no token collision survives.
    const existing = existingOAs[0]
    // Refuse if ANY signature has already been collected — not just when the OA
    // is fully signed. A multi-member OA stays 'partially_signed' until the LAST
    // member signs, so the old `status === 'signed'` guard let a re-generate
    // hard-delete executed member signatures with no soft-delete and no audit
    // row (R100). Reported by the Council 2026-07-22; no client was exposed at
    // the time, but making the nav entry always visible drives more traffic here.
    if (hasCollectedSignatures(existing)) {
      return NextResponse.json({ error: 'This Operating Agreement has already been signed, or is waiting on the remaining members to sign. Contact support if you need a new one.' }, { status: 409 })
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
    // A VOIDED agreement's signatures go too — they are legally dead and the
    // whole point of a void is to let the client start over. For any LIVE
    // agreement, signed rows are excluded so the race below cannot destroy one.
    const sigDelete = supabaseAdmin.from('oa_signatures').delete().eq('oa_id', existing.id)
    await (existing.status === 'voided' ? sigDelete : sigDelete.neq('status', 'signed'))

    // Re-count SIGNED rows only. Counting ALL rows here silently undid the
    // voided exemption above: a voided agreement carrying a signed signature
    // kept that row through the delete, so the count came back > 0 and this
    // refused — permanently, since retrying could never clear it. The portal
    // meanwhile tells that client "this is outdated, generate a new one". The
    // client was trapped, with a message blaming a race that never happened.
    // Caught in round 5 by a reviewer who re-ran the round-3 fixture I did not.
    const { count: survivors, error: survivorErr } = await supabaseAdmin
      .from('oa_signatures')
      .select('id', { count: 'exact', head: true })
      .eq('oa_id', existing.id)
      .eq('status', 'signed')

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

    // Sweep every OTHER row for this account too — an older sibling would collide
    // on the token and make the new agreement unreachable on every channel.
    //
    // NEVER a signed one. I first wrote this relying on an argument that a signed
    // older row could not exist; that is reasoning, not a guarantee, and the cost
    // of being wrong is deleting an executed agreement. Excluding them by filter
    // makes it structural. (Checked production: no account currently holds more
    // than one row and no token is shared, so this is defensive today — it stops
    // the collision arising, rather than repairing one.)
    const staleIds = existingOAs.filter(o => o.status !== 'signed').map(o => o.id)
    if (staleIds.length > 0) {
      await supabaseAdmin.from('oa_signatures').delete().in('oa_id', staleIds)
      await supabaseAdmin.from('oa_agreements').delete().in('id', staleIds)
    }
  }

  // ── 6. BUILD MEMBERS JSON FOR MMLLC ──
  // No priority list any more: the member row IS the address. The shared resolver
  // is the SAME one `getPortalMembers` uses to render the screen, so what the
  // client reviewed and what is stored here cannot drift apart — that is the whole
  // point of it living in lib/members/member-address.ts rather than being composed
  // locally at each call site, which is how the two came to disagree.
  //
  // A member with no address on file resolves to null and the templates print
  // "As on file with the Company". That is deliberate: an absent address stays
  // visibly absent rather than being quietly filled from the representative's
  // personal address or from anywhere else.
  // For an MMLLC this now EQUALS the member count: the gate above refuses to
  // issue the agreement unless every member can be sent a signature request, so
  // signers and roster cannot diverge. Kept as the signing-set length rather
  // than membersRows.length so the two can never disagree if the gate is ever
  // relaxed — and so this reads as what it means (how many signatures we are
  // waiting for), not as a coincidence.
  const totalSigners = isMMLC ? oaSigners.length : 1
  const membersJson = isMMLC
    ? membersRows.map(m => ({
        name: m.full_name ?? m.company_name ?? 'Unknown',
        address: formatMemberAddressRow(m),
        email: m.email ?? null,
        ownership_pct: m.ownership_pct ?? 0,
        initial_contribution: '$1,000 USD',
      }))
    : null

  // The single-member agreement's address, resolved the same way. Where a member
  // row exists it wins; a rosterless company falls through to the owner's own
  // contact record, which is what the screen displays read-only.
  // For a no-roster account the OWNER'S CONTACT RECORD is the record. Read it
  // whenever the caller did not supply a new address, so a client who generates a
  // second agreement without retyping gets the address they already gave us
  // instead of a document reading "As on file with the Company" while their record
  // holds it — the same record-vs-document split this job exists to close, and
  // what the first cut of this change did on exactly this path.
  const soleMemberAddress = resolveSoleMemberAddress({
    hasMemberRecords,
    primaryMemberRow: pickSoleMemberRow(membersRows),
    ownerRecordAddress,
  })

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
      // Never null: the templates interpolate this straight into Article 1.1
      // ("...filing office on ${formation_date}."), so a missing date printed the
      // literal word "null" in the executed agreement. Accounts imported or
      // created for clients who already owned their company routinely lack it.
      // Fall back to the effective date, then today — same as the staff paths.
      formation_date: account.formation_date || effective_date || new Date().toISOString().split('T')[0],
      ein_number: account.ein_number ?? null,
      entity_type: entityType,
      // ROSTERLESS PATH ONLY. A company WITH a member roster is untouched — that
      // roster already drives its naming, and whether the manager on a
      // multi-member agreement should be its creator is a separate question with
      // its own card, not a change to make tonight.
      manager_name: hasMemberRecords ? contact.full_name : (ownerName as string),
      member_name: isMMLC
        ? (primaryMember?.full_name ?? contact.full_name)
        : (hasMemberRecords ? contact.full_name : (ownerName as string)),
      // Only the SMLLC templates render this (Article 2.1 "Sole Member"); the
      // multi-member ones print the roster from `members` above. It used to be
      // `member_addresses[0]` — the browser's first typed value — which on a
      // multi-member agreement stored one member's typed address in a column
      // labelled as the sole member's, for no reader.
      member_address: shouldStoreSoleMemberAddress(isMMLC) ? soleMemberAddress : null,
      member_email: isMMLC
        ? (primaryMember?.email ?? contact.email)
        : (hasMemberRecords ? contact.email : (ownerEmail ?? contact.email)),
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
      // 'sent', NOT 'draft' — this route chats the signing link to every member
      // in the SAME request (see the portal-message sends below), so the OA has
      // demonstrably been sent. Filing it as 'draft' was a lie the rest of the
      // system believed: /portal/sign hides drafts and the home Action Items
      // exclude them, so the client was sent a link to a document that was
      // invisible everywhere in their portal until they happened to click it
      // (which flips it to 'viewed'). 'draft' still means "staff is drafting,
      // not yet sent" on the MCP oa_create path — do not unify the two writers.
      // (Lorenzo Cassi, 2026-07-22: created it, saw a success screen, then asked
      // "dove firmo?" — the self-service clients this bit.)
      status: 'sent',
      total_signers: totalSigners,
      signed_count: 0,
    })
    .select('id, token, access_code')
    .single()

  if (insertErr || !oa) {
    return NextResponse.json({ error: insertErr?.message ?? 'Failed to create OA' }, { status: 500 })
  }

  // NO WRITE-BACK. A document-generation screen READS the record; only the
  // record's own screen writes it. The removed version wrote the client's typed
  // address into their contact row (and into the legacy `residency` column that
  // other code reads as a country), which forced an unreliable "who is the owner"
  // lookup to become load-bearing for a WRITE — and, through a lossy address
  // split, erased city/state/postal-code/country for contacts whose address had
  // fewer than five parts. A sole owner corrects their address on their profile.

  // ── 8. FOR MMLLC: INSERT OA_SIGNATURES + SEND PORTAL CHAT ──
  const notifyOutcomes: Awaited<ReturnType<typeof notifyClientActionRequired>>[] = []
  // Is the person who just pressed the button themselves a signer? For a
  // single-member company they always are. For a multi-member one the creator
  // may be an administrator who is not among the members — offering them a
  // "Sign now" button lands them on a read-only page with nothing to click.
  let callerCanSign = !isMMLC

  if (isMMLC) {
    // One row per SIGNER, not per member. A company member's row carries its
    // representative — the human who signs on the company's behalf.
    // link_expires_at is stamped NOW because this same request emails each signer
    // their link — a 15-day window on the emailed credential (Antonio, 2026-08-11).
    const linkExpiry = signerLinkExpiryISO()
    const sigRows = oaSigners.map((s, idx) => ({
      oa_id: oa.id,
      member_index: idx,
      member_name: signerDisplayName(s),
      member_email: s.email,
      contact_id: s.contactId,
      link_expires_at: linkExpiry,
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
