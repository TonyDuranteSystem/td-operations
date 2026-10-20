/**
 * POST /api/portal/operating-agreement/fix-members
 *
 * The pop-up on the client's Generate Documents screen (dev job d016d398, Antonio 2026-10-20): when a
 * multi-member company's Operating Agreement cannot be issued because an owner's details are missing,
 * the PRIMARY owner fills them in here and the CRM is updated.
 *
 * What it will and will not do (rules in lib/members/oa-member-gaps.ts):
 *   - only the company's primary member may call it;
 *   - it FILLS BLANKS and replaces ownership percentages — it never rewrites a value already on file
 *     (so nobody can swap another owner's signing email);
 *   - the roster must be complete, total exactly 100%, and two members with the same name must have
 *     different emails;
 *   - each member's contact is found or created (shared resolver) and linked to the company as Member;
 *   - a dated note goes on the company (CRM update rule) and the change is logged.
 * It does not create the agreement — the screen calls the create route again afterwards.
 *
 * Body: { account_id: string, members: Array<{ id: string, email?, address_street?, ..., ownership_pct? }> }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { logAction } from '@/lib/mcp/action-log'
import { hasCollectedSignatures } from '@/lib/portal/oa-regenerate-guard'
import { startHistoryFromNow } from '@/lib/portal/history-cutoff'
import { appendAccountNote } from '@/lib/operations/account'
import { resolveMemberContactId } from '@/lib/members/resolve-member-contact'
import {
  FILLABLE_FIELDS, applyMemberEdits, isCompanyMember, memberLabel, primaryAccess, rosterNeedsAttention, rosterProblem, signingEmail,
  type MemberEdit, type RosterMember,
} from '@/lib/members/oa-member-gaps'

const MEMBER_COLUMNS = 'id, member_type, full_name, company_name, email, ownership_pct, is_primary, is_signer, contact_id, address_street, address_city, address_state, address_zip, address_country, representative_name, representative_email'

type DbMember = RosterMember & { is_primary: boolean | null; is_signer: boolean | null; contact_id: string | null }

function cleanEdits(raw: unknown): MemberEdit[] {
  if (!Array.isArray(raw)) return []
  const out: MemberEdit[] = []
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') continue
    const src = item as Record<string, unknown>
    const edit: MemberEdit = { id: src.id as string }
    for (const f of FILLABLE_FIELDS) {
      const v = src[f]
      if (typeof v === 'string') edit[f] = v.trim().slice(0, 200)
    }
    if (src.ownership_pct !== undefined && src.ownership_pct !== null && src.ownership_pct !== '') {
      const n = Number(src.ownership_pct)
      if (Number.isFinite(n)) edit.ownership_pct = n
    }
    out.push(edit)
  }
  return out
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked to your account' }, { status: 403 })

  let body: { account_id?: string; members?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const accountId = body.account_id
  if (!accountId) return NextResponse.json({ error: 'account_id is required' }, { status: 400 })

  const accessibleIds = await getClientAccountIds(contactId)
  if (!accessibleIds.includes(accountId)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, member_structure')
    .eq('id', accountId)
    .single()
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  const isMMLC = normalizeEntityType(account.entity_type as string | null) === 'MMLLC' || account.member_structure === 'multi_member'
  if (!isMMLC) return NextResponse.json({ error: 'This company has a single owner — there is nothing to complete.' }, { status: 400 })

  const { data: rows } = await supabaseAdmin
    .from('members')
    .select(MEMBER_COLUMNS)
    .eq('account_id', accountId)
    .order('is_primary', { ascending: false })
  const members = (rows ?? []) as DbMember[]
  if (members.length === 0) return NextResponse.json({ error: 'No owners are on file for this company — please contact support.' }, { status: 422 })

  const access = primaryAccess(members, { contactId, email: user.email })
  if (access === 'not_primary') {
    const primaryName = members.filter(m => m.is_primary).map(memberLabel).join(', ')
    return NextResponse.json({ error: `Only the primary owner${primaryName ? ` (${primaryName})` : ''} can update the owners' details. Please ask them, or contact support@tonydurante.us.` }, { status: 403 })
  }
  // Nobody is flagged primary or signer: staff must set that first — never open this door to every linked contact.
  if (access === 'no_primary') {
    return NextResponse.json({ error: 'Please contact support@tonydurante.us — we need to finish setting up your company before the owners\' details can be updated.' }, { status: 403 })
  }

  // Only while something is actually missing, and never once anyone has signed (the signed document would then disagree with the records).
  if (!rosterNeedsAttention(members)) {
    return NextResponse.json({ error: 'Everything is already complete — there is nothing to update here.' }, { status: 409 })
  }
  const { data: latestOa } = await supabaseAdmin
    .from('oa_agreements')
    .select('status, signed_count')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (latestOa?.[0] && hasCollectedSignatures(latestOa[0])) {
    return NextResponse.json({ error: 'The Operating Agreement has already been signed (or is partly signed), so the owners\' details can no longer be changed here. Please contact support@tonydurante.us.' }, { status: 409 })
  }

  const edits = cleanEdits(body.members)
  const after = applyMemberEdits(members, edits)
  // The client can only fix what they typed: an old malformed email on a row they cannot edit must not block them.
  const typedEmailIds = new Set(
    edits
      .filter(e => {
        const before = members.find(m => m.id === e.id)
        if (!before) return false
        const field = isCompanyMember(before) ? 'representative_email' : 'email'
        return (before[field] ?? '').trim() === '' && !!(e[field] ?? '').trim()
      })
      .map(e => e.id),
  )
  const problem = rosterProblem(after, { typedEmailIds })
  if (problem) return NextResponse.json({ error: problem }, { status: 422 })

  // ── Write: only what changed ──
  const now = new Date().toISOString()
  const changes: string[] = []
  for (const before of members) {
    const next = after.find(a => a.id === before.id)!
    const patch: Record<string, string | number> = {}
    const filled: string[] = []
    for (const f of FILLABLE_FIELDS) {
      if ((before[f] ?? '').trim() === '' && (next[f] ?? '').trim() !== '') { patch[f] = next[f] as string; filled.push(f) }
    }
    const pctChanged = Number(before.ownership_pct) !== Number(next.ownership_pct)
    if (pctChanged) patch.ownership_pct = Number(next.ownership_pct)
    if (Object.keys(patch).length === 0) continue
    const { error } = await supabaseAdmin.from('members').update({ ...patch, updated_at: now }).eq('id', before.id).eq('account_id', accountId)
    if (error) return NextResponse.json({ error: 'We could not save the details — please try again or contact support@tonydurante.us.' }, { status: 500 })
    if (filled.length) changes.push(`${memberLabel(before)}: added ${filled.map(f => f.replace(/_/g, ' ')).join(', ')}`)
    if (pctChanged) changes.push(`${memberLabel(before)}: ownership ${Number(before.ownership_pct) || 0}% → ${Number(next.ownership_pct)}%`)
  }

  // ── Contacts: find-or-create each signer and link as Member ──
  const failed: string[] = []
  for (const m of after) {
    if (m.contact_id) {
      if (Number(members.find(b => b.id === m.id)?.ownership_pct) !== Number(m.ownership_pct)) {
        const { error } = await supabaseAdmin.from('account_contacts').update({ ownership_pct: Number(m.ownership_pct) }).eq('account_id', accountId).eq('contact_id', m.contact_id)
        if (error) failed.push(memberLabel(m))
      }
      continue
    }
    const email = signingEmail(m)
    const name = isCompanyMember(m) ? m.representative_name : m.full_name
    if (!email || !name) continue
    const newContactId = await resolveMemberContactId({
      email,
      name,
      first_name: name.split(/\s+/)[0] || null,
      last_name: name.split(/\s+/).slice(1).join(' ') || null,
      refresh: isCompanyMember(m) ? undefined : {
        address_line1: m.address_street, address_city: m.address_city, address_state: m.address_state,
        address_zip: m.address_zip, address_country: m.address_country,
      },
      now,
    })
    if (!newContactId) { failed.push(memberLabel(m)); continue }
    const { data: already } = await supabaseAdmin.from('account_contacts').select('contact_id').eq('account_id', accountId).eq('contact_id', newContactId).maybeSingle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ownership_pct / is_primary are not in the generated types
    const { error: linkErr } = await supabaseAdmin.from('account_contacts').upsert({ account_id: accountId, contact_id: newContactId, role: 'Member', ownership_pct: Number(m.ownership_pct) } as any, { onConflict: 'account_id,contact_id', ignoreDuplicates: true })
    const { error: memErr } = await supabaseAdmin.from('members').update({ contact_id: newContactId, updated_at: now }).eq('id', m.id).is('contact_id', null)
    if (linkErr || memErr) { failed.push(memberLabel(m)); continue }
    // A person added to a company that already has history sees it only from today (Antonio 2026-10-17) — and the email here was typed, not verified.
    if (!already) await startHistoryFromNow({ accountId, contactId: newContactId })
    changes.push(`${memberLabel(m)}: contact linked as Member`)
  }
  if (failed.length > 0) {
    return NextResponse.json({ error: `We could not finish saving the details for ${failed.join(', ')} — please try again or contact support@tonydurante.us.` }, { status: 500 })
  }

  if (changes.length > 0) {
    await appendAccountNote({
      id: accountId,
      note: `Owners' details completed by the client in the portal before the Operating Agreement — ${changes.join('; ')}.`,
    })
    logAction({
      actor: `portal:${user.email ?? contactId}`,
      action_type: 'update',
      table_name: 'members',
      account_id: accountId,
      summary: `Client completed owners' details for ${account.company_name}`,
      details: { changes },
    })
  }

  return NextResponse.json({ ok: true, changed: changes.length })
}
