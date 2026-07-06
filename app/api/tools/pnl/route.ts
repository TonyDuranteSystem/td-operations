/**
 * Standalone P&L tool — workspace collection routes (STAFF ONLY, isDashboardUser).
 *
 * POST /api/tools/pnl   — create a workspace (blank OR fork a client).
 * GET  /api/tools/pnl   — list the current staff user's workspaces.
 *
 * A workspace is an ISOLATED sandbox: nothing here reads or writes a real
 * client's books. A FORK copies the client's transactions + members + prior
 * return into the workspace tables (a private copy); the real client is
 * untouched. MMLLC-only (entity guard) — the registry has no other engine yet.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { fetchAllBankTransactionsByYear } from '@/lib/bank-transactions-fetch'
import { deriveFirstYearFromFormation } from '@/lib/tax/workspace-prior-return'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

interface MemberInput {
  member_type?: string
  display_name?: string
  ownership_pct?: number | string | null
  details?: Record<string, unknown>
}

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const { data, error } = await db
    .from('pnl_workspaces')
    .select('id, label, company_name, tax_year, entity_type, linked_account_id, status, created_at, updated_at')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ workspaces: data ?? [] })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  const actor = user?.email ?? user?.id ?? 'staff'

  const body = await request.json().catch(() => ({})) as {
    mode?: 'blank' | 'fork'
    label?: string
    tax_year?: number
    company_name?: string
    ein?: string
    members?: MemberInput[]
    source_account_id?: string
  }
  const taxYear = Number(body.tax_year)
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    return NextResponse.json({ error: 'A valid tax year is required.' }, { status: 400 })
  }

  try {
    if (body.mode === 'fork') {
      return await createFork({ actor, taxYear, sourceAccountId: body.source_account_id, label: body.label })
    }
    return await createBlank({ actor, taxYear, label: body.label, companyName: body.company_name, ein: body.ein, members: body.members ?? [] })
  } catch (err) {
    console.error('[tools/pnl] create failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not create the workspace.' }, { status: 500 })
  }
}

async function createBlank(input: { actor: string; taxYear: number; label?: string; companyName?: string; ein?: string; members: MemberInput[] }) {
  const { data: ws, error } = await db
    .from('pnl_workspaces')
    .insert({
      created_by: input.actor,
      label: input.label || input.companyName || `New P&L ${input.taxYear}`,
      tax_year: input.taxYear,
      entity_type: 'MMLLC',
      company_name: input.companyName ?? null,
      ein: input.ein ?? null,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  await insertMembers(ws.id, input.members)
  return NextResponse.json({ id: ws.id })
}

async function createFork(input: { actor: string; taxYear: number; sourceAccountId?: string; label?: string }) {
  if (!input.sourceAccountId) return NextResponse.json({ error: 'source_account_id is required for a fork.' }, { status: 400 })

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('company_name, ein_number, entity_type, formation_date')
    .eq('id', input.sourceAccountId)
    .maybeSingle()
  if (acctErr) throw new Error(acctErr.message)
  if (!account) return NextResponse.json({ error: 'Client account not found.' }, { status: 404 })

  // Entity guard — only MMLLC has a registered P&L engine today.
  if (normalizeEntityType(account.entity_type as string | null) !== 'MMLLC') {
    return NextResponse.json({ error: 'The standalone P&L tool currently supports Multi-Member LLC clients only.' }, { status: 400 })
  }

  // Prior-return snapshot from the client's latest completed submission.
  const { data: sub } = await db
    .from('tax_return_submissions')
    .select('prior_return_extracted')
    .eq('account_id', input.sourceAccountId)
    .eq('tax_year', input.taxYear)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: ws, error: wsErr } = await db
    .from('pnl_workspaces')
    .insert({
      created_by: input.actor,
      label: input.label || `${account.company_name ?? 'Client'} ${input.taxYear} (copy)`,
      linked_account_id: input.sourceAccountId,
      tax_year: input.taxYear,
      entity_type: 'MMLLC',
      company_name: account.company_name ?? null,
      ein: account.ein_number ?? null,
      // No wizard answer? A company formed IN/AFTER the filing year cannot
      // have a prior return — auto-derive first_year from the CRM formation
      // date instead of nagging staff for an answer that can never exist
      // (2026-07-06; positive confirmation only, no formation date = null).
      prior_return_snapshot: sub?.prior_return_extracted
        ?? deriveFirstYearFromFormation((account.formation_date as string | null) ?? null, input.taxYear),
    })
    .select('id')
    .single()
  if (wsErr) throw new Error(wsErr.message)

  // Copy the client's member roster (account_contacts → workspace members).
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('ownership_pct, contacts(first_name, last_name)')
    .eq('account_id', input.sourceAccountId)
  const members: MemberInput[] = ((links ?? []) as unknown as Array<{ ownership_pct: number | null; contacts: { first_name: string | null; last_name: string | null } | null }>)
    .filter(l => l.contacts)
    .map(l => ({
      member_type: 'individual',
      display_name: `${l.contacts!.first_name ?? ''} ${l.contacts!.last_name ?? ''}`.trim(),
      ownership_pct: l.ownership_pct,
    }))
    .filter(m => (m.display_name ?? '').length > 0)
  await insertMembers(ws.id, members)

  // Copy the client's transactions for the year into the workspace (private copy).
  const txRows = await fetchAllBankTransactionsByYear<Record<string, unknown>>(
    input.sourceAccountId,
    input.taxYear,
    'transaction_date, description, category, subcategory, counterparty, amount, currency, balance_after, bank_name, account_type, transaction_ref, source_file_id, is_related_party, notes, ai_lean, ai_bucket',
  )
  let copied = 0
  const BATCH = 500
  for (let i = 0; i < txRows.length; i += BATCH) {
    const batch = txRows.slice(i, i + BATCH).map(r => ({ ...r, workspace_id: ws.id, tax_year: input.taxYear }))
    if (batch.length === 0) continue
    const { error } = await db.from('pnl_workspace_transactions').upsert(batch, { onConflict: 'workspace_id,transaction_ref,transaction_date,amount', ignoreDuplicates: true })
    if (error) throw new Error(`Failed copying transactions: ${error.message}`)
    copied += batch.length
  }

  return NextResponse.json({ id: ws.id, forked: true, copiedTransactions: copied, members: members.length })
}

async function insertMembers(workspaceId: string, members: MemberInput[]) {
  const rows = members
    .map(m => ({
      workspace_id: workspaceId,
      member_type: m.member_type === 'company' ? 'company' : 'individual',
      display_name: (m.display_name ?? '').trim(),
      ownership_pct: m.ownership_pct === '' || m.ownership_pct === undefined ? null : m.ownership_pct,
      details: m.details ?? {},
    }))
    .filter(m => m.display_name.length > 0)
  if (rows.length === 0) return
  const { error } = await db.from('pnl_workspace_members').insert(rows)
  if (error) throw new Error(`Failed to add members: ${error.message}`)
}
