import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'

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
  const { action, actor, force } = await req.json()

  if (action !== 'activate' && action !== 'deactivate') {
    return NextResponse.json({ error: 'action must be "activate" or "deactivate"' }, { status: 400 })
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

    return NextResponse.json({ ok: true, contactBlocks: [], accountTierSet: newTier })
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

  await supabaseAdmin.from('action_log').insert({
    account_id: params.id,
    action_type: `audit_portal_${action}`,
    table_name: 'auth.users',
    summary: `Audit: portal login ${action === 'deactivate' ? 'blocked' : 'restored'} — ${blocks.filter(b => b.reason === 'banned' || b.reason === 'unbanned').length} of ${contacts.length} contact(s) updated${skippedMulti.length > 0 ? ` (${skippedMulti.length} skipped: multi-account)` : ''}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    details: { actor: actor ?? 'audit-panel', blocks } as any,
  })

  return NextResponse.json({
    ok: true,
    contactBlocks: blocks,
    skippedMultiAccount: skippedMulti,
  })
}
/* eslint-enable no-restricted-syntax */
