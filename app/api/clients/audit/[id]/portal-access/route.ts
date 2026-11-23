import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { createClient } from '@/lib/supabase/server'
import { tdActorFromRequest } from '@/lib/portal/team/events'
import { companyBlockDeps, describeCompanyBlock, switchOffCompanyLogins, switchOnCompanyLogins, type CompanyBlockResult } from '@/lib/portal/team/company-block'

export const dynamic = 'force-dynamic'

/**
 * POST /api/clients/audit/[id]/portal-access
 * Body: { action: 'activate' | 'deactivate', actor?: string, force?: boolean }
 *
 * "Block portal login" semantic — does NOT change tier values.
 * Tier values describe what the client SEES; auth-user banned state
 * decides whether they can log in at all.
 *
 * Deactivate:
 *   - For each linked contact, find their auth user and ban it (banned_until = far future)
 *   - If a linked contact has OTHER active-tier accounts, skip them and report
 *     unless `force: true` is set (because banning their auth user would also
 *     block them from those other accounts)
 *   - Edge case (no contacts at all): just clear account.portal_tier (stale state)
 *
 * Activate:
 *   - For each linked contact, unban their auth user (ban_duration = 'none')
 *   - Edge case (no contacts): set account.portal_tier = 'active' so the
 *     account is at least marked as eligible (no actual login until contact added)
 *
 * TEAM LOGINS (Team Powers, dev job e59dd470): a team login is not a contact, so the steps above never reached it. Block also switches off every
 * ACTIVE team login of THIS company (the Team card's own TD switch-off: reversible, silent, written to the team record with the staff email);
 * Restore switches back on ONLY the ones this block switched off (a login an owner switched off, or TD switched off for another reason, stays
 * as it is). A failure on a team login never fails the request: it is reported in `teamLogins` / `teamLoginsError` and the screen says so.
 */

const BAN_FOREVER = '876600h' // 100 years — Supabase Auth admin "ban_duration" string

interface ContactBlock {
  contact_id: string
  email: string | null
  reason: 'banned' | 'unbanned' | 'skipped_multi_account' | 'skipped_no_email' | 'skipped_no_auth_user' | 'error'
  detail?: string
}

/* eslint-disable no-restricted-syntax */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { action, actor, force } = await req.json()

  if (action !== 'activate' && action !== 'deactivate') {
    return NextResponse.json({ error: 'action must be "activate" or "deactivate"' }, { status: 400 })
  }

  // The staff login behind the click: the team record names who switched the team logins off or on.
  const { data: { user: staffUser } } = await createClient().auth.getUser()
  if (!staffUser?.email) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  const teamActor = tdActorFromRequest(staffUser.email, req.headers)

  /** The company's team logins (never throws: a problem here is reported next to the contact result, it never undoes it). */
  const handleTeamLogins = async (): Promise<{ teamLogins: CompanyBlockResult | null; teamLoginsError: string | null; teamLoginsNote: string }> => {
    try {
      const teamLogins = action === 'deactivate'
        ? await switchOffCompanyLogins(params.id, teamActor, companyBlockDeps())
        : await switchOnCompanyLogins(params.id, teamActor, companyBlockDeps())
      return { teamLogins, teamLoginsError: null, teamLoginsNote: describeCompanyBlock(action, teamLogins) }
    } catch (err) {
      const teamLoginsError = err instanceof Error ? err.message : 'Could not read the team logins'
      return { teamLogins: null, teamLoginsError, teamLoginsNote: describeCompanyBlock(action, null, teamLoginsError) }
    }
  }

  // ── Get linked contacts ──
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id, contact:contacts(id, full_name, email)')
    .eq('account_id', params.id)

  const contacts = (links ?? [])
    .map(l => l.contact as unknown as { id: string; full_name: string | null; email: string | null } | null)
    .filter((c): c is { id: string; full_name: string | null; email: string | null } => !!c)

  // ── Edge case: no contacts → just toggle account.portal_tier ──
  if (contacts.length === 0) {
    const newTier = action === 'activate' ? 'active' : null
    const { error } = await supabaseAdmin
      .from('accounts')
      .update({ portal_tier: newTier, updated_at: new Date().toISOString() })
      .eq('id', params.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await supabaseAdmin.from('action_log').insert({
      account_id: params.id,
      action_type: `audit_portal_${action}`,
      table_name: 'accounts',
      summary: `Audit: account had no contacts — account.portal_tier set to ${newTier ?? 'null'}`,
    })

    const team = await handleTeamLogins()
    if (team.teamLoginsNote) {
      await supabaseAdmin.from('action_log').insert({
        account_id: params.id,
        action_type: `audit_portal_${action}`,
        table_name: 'portal_team_members',
        summary: `Audit: team logins — ${team.teamLoginsNote}`,
      })
    }
    return NextResponse.json({ ok: true, contactBlocks: [], accountTierSet: newTier, ...team })
  }

  // ── For each linked contact, find auth user, check multi-account, ban/unban ──
  const blocks: ContactBlock[] = []
  const skippedMulti: string[] = []

  for (const c of contacts) {
    if (!c.email) {
      blocks.push({ contact_id: c.id, email: null, reason: 'skipped_no_email' })
      continue
    }

    const authUser = await findAuthUserByEmail(c.email)
    if (!authUser) {
      blocks.push({ contact_id: c.id, email: c.email, reason: 'skipped_no_auth_user' })
      continue
    }

    // Multi-account safety check (only relevant for deactivate)
    if (action === 'deactivate' && !force) {
      const { data: otherLinks } = await supabaseAdmin
        .from('account_contacts')
        .select('account:accounts(id, company_name, portal_tier)')
        .eq('contact_id', c.id)
        .neq('account_id', params.id)

      const otherActive = (otherLinks ?? [])
        .map(l => l.account as unknown as { id: string; company_name: string; portal_tier: string | null } | null)
        .filter((a): a is { id: string; company_name: string; portal_tier: string | null } => !!a)
        .filter(a => a.portal_tier === 'active')

      if (otherActive.length > 0) {
        skippedMulti.push(`${c.full_name ?? c.email} (also has access to: ${otherActive.map(a => a.company_name).join(', ')})`)
        blocks.push({
          contact_id: c.id,
          email: c.email,
          reason: 'skipped_multi_account',
          detail: otherActive.map(a => a.company_name).join(', '),
        })
        continue
      }
    }

    // Ban or unban the auth user
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updatePayload: any = action === 'deactivate'
        ? { ban_duration: BAN_FOREVER }
        : { ban_duration: 'none' }

      const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, updatePayload)
      if (authErr) {
        blocks.push({ contact_id: c.id, email: c.email, reason: 'error', detail: authErr.message })
      } else {
        blocks.push({
          contact_id: c.id,
          email: c.email,
          reason: action === 'deactivate' ? 'banned' : 'unbanned',
        })
      }
    } catch (err) {
      blocks.push({
        contact_id: c.id,
        email: c.email,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const team = await handleTeamLogins()

  await supabaseAdmin.from('action_log').insert({
    account_id: params.id,
    action_type: `audit_portal_${action}`,
    table_name: 'auth.users',
    summary: `Audit: portal login ${action === 'deactivate' ? 'blocked' : 'restored'} — ${blocks.filter(b => b.reason === 'banned' || b.reason === 'unbanned').length} of ${contacts.length} contact(s) updated${skippedMulti.length > 0 ? ` (${skippedMulti.length} skipped: multi-account)` : ''}${team.teamLoginsNote ? `; team logins: ${team.teamLoginsNote}` : ''}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    details: { actor: actor ?? 'audit-panel', blocks, team_logins: team.teamLogins, team_logins_error: team.teamLoginsError } as any,
  })

  return NextResponse.json({
    ok: true,
    contactBlocks: blocks,
    skippedMultiAccount: skippedMulti,
    ...team,
  })
}
/* eslint-enable no-restricted-syntax */
