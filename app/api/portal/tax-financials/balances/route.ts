/**
 * POST /api/portal/tax-financials/balances
 *   { account_id, tax_year, balances: [{ bank_key, currency, opening_balance, closing_balance }] }
 *
 * Record per-bank opening/closing balances (S2 slice 2) — the two statement-
 * header numbers that anchor the per-bank tie-out and the third beginning-cash
 * source. Balances are stored in the account's own currency; the engine
 * converts for the consolidated sheet. Upsert per (account, year, bank_key).
 *
 * OWNER-ONLY (staff sessions pass — non-client roles are allowed through
 * isAccountOwner, stored with source='staff'); post-confirm lock; resets the
 * attestation (the anchors change what the client is confirming).
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const CUR_RE = /^[A-Z]{3}$/

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({})) as {
      account_id?: string; tax_year?: number
      balances?: Array<{ bank_key?: string; currency?: string; opening_balance?: number | null; closing_balance?: number | null }>
    }
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    const balances = Array.isArray(body.balances) ? body.balances.slice(0, 50) : []
    if (!accountId || !Number.isInteger(taxYear) || balances.length === 0) {
      return NextResponse.json({ error: 'account_id, tax_year and balances are required.' }, { status: 400 })
    }
    for (const b of balances) {
      const numOk = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e13)
      if (!b.bank_key || typeof b.bank_key !== 'string' || b.bank_key.length > 120
        || !CUR_RE.test(String(b.currency ?? 'USD'))
        || !numOk(b.opening_balance) || !numOk(b.closing_balance)) {
        return NextResponse.json({ error: 'Each balance needs a bank_key, a 3-letter currency, and numeric (or empty) opening/closing balances.' }, { status: 400 })
      }
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Post-confirm lock — same rule as answers.
    // ONE resolver for which row is the client's file (see resolve-submission.ts):
    // the newest with real data. The old "newest of ANY status" let an unfilled
    // pending/opened form outrank the real submission and unlock it.
    const { resolveEditability } = await import('@/lib/tax/resolve-submission')
    const { editable: canEdit } = await resolveEditability(supabaseAdmin, accountId, taxYear)
    if (!canEdit) {
      return NextResponse.json({ error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it before changing balances.' }, { status: 409 })
    }

    const role = (user.app_metadata as Record<string, unknown> | undefined)?.role
    const source = role === 'client' ? 'client' : 'staff'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // table not yet in database.types.ts
    let saved = 0
    for (const b of balances) {
      const { error } = await db
        .from('account_bank_balances')
        .upsert({
          account_id: accountId,
          tax_year: taxYear,
          bank_key: b.bank_key,
          currency: String(b.currency ?? 'USD'),
          opening_balance: b.opening_balance ?? null,
          closing_balance: b.closing_balance ?? null,
          source,
          created_by: user.email ?? user.id,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'account_id,tax_year,bank_key' })
      if (error) return NextResponse.json({ error: `Could not save ${b.bank_key}: ${error.message}` }, { status: 500 })
      saved++
    }

    try {
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, `bank balances updated (${saved})`)
    } catch (e) {
      console.error('[portal balances] attestation reset failed:', e)
    }
    try {
      await db.from('action_log').insert({
        actor: user.email ?? user.id,
        action_type: 'bank_balances_updated',
        table_name: 'account_bank_balances',
        record_id: accountId,
        account_id: accountId,
        summary: `${source} recorded ${saved} per-bank balance anchor(s) for ${taxYear}`,
        details: { tax_year: taxYear, banks: balances.map(b => b.bank_key) },
      })
    } catch (e) {
      console.error('[portal balances] audit failed:', e)
    }

    return NextResponse.json({ ok: true, saved })
  } catch (err) {
    console.error('[portal balances] failed:', err)
    return NextResponse.json({ error: 'Could not save the balances — please try again.' }, { status: 500 })
  }
}
