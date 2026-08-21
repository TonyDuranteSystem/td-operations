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
    .select('prior_return_extracted, financials_meta')
    .eq('account_id', input.sourceAccountId)
    .eq('tax_year', input.taxYear)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Refuse to fork a client whose REAL data already has a structural problem
  // (2026-08-20 hard-stop plan). Copying transactions never copies job_queue
  // history — a fresh workspace has no jobs at all, so it would silently
  // report "nothing wrong" even when the source is missing a whole failed
  // file, defeating the entire point of the hard-stop for the fork path
  // (senior-engineer finding, council review). Simplest correct fix: check
  // the source's OWN live state before copying anything, and refuse outright
  // — a disposable test copy of known-broken data is never useful anyway.
  const { data: sourceJobs } = await supabaseAdmin
    .from('job_queue')
    .select('status, result, payload')
    .eq('job_type', 'ingest_bank_statement')
    .eq('account_id', input.sourceAccountId)
    .in('status', ['pending', 'processing', 'failed', 'completed'])
  const { computeIngestFileStates, summarizeIngestFileStates } = await import('@/lib/tax/ingest-file-status')
  const sourceFileStates = computeIngestFileStates(
    (sourceJobs ?? []) as Array<{ status: string; result: { ok?: boolean; steps?: Array<{ detail?: string }> } | null; payload: { tax_year?: number | string; path?: string } | null }>,
    input.taxYear,
  )
  const sourceCounts = summarizeIngestFileStates(sourceFileStates)
  const sourceMeta = (sub?.financials_meta ?? {}) as Record<string, unknown>
  const sourceCoverageAnswers = (sourceMeta.coverage_answers ?? {}) as import('@/lib/tax/coverage').CoverageAnswers
  const { coverageQuestions, unansweredCoverage, incompleteCoverage, hasStructuralProblem } = await import('@/lib/tax/coverage')
  const sourceSources = await fetchAllBankTransactionsByYear<{ bank_name: string; account_type: string | null; transaction_date: string }>(
    input.sourceAccountId, input.taxYear, 'bank_name, account_type, transaction_date',
  )
  const sourceCovQs = coverageQuestions(sourceSources, input.taxYear)
  const sourceStructuralProblem = hasStructuralProblem({
    ingestFailed: sourceCounts.failed,
    failedFilesOverridden: sourceMeta.failed_files_override != null,
    unansweredCoverage: unansweredCoverage(sourceCovQs, sourceCoverageAnswers).length,
    incompleteCoverage: incompleteCoverage(sourceCovQs, sourceCoverageAnswers).length,
  })
  if (sourceStructuralProblem) {
    return NextResponse.json({
      error: 'This client\'s real data has an unresolved problem (an unreadable statement or a missing-months question) — fix that on their real account first, then fork. A test copy of known-incomplete data would only reproduce the same problem invisibly.',
    }, { status: 409 })
  }

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
      // Carry the source's already-resolved coverage answers so the fork
      // doesn't re-ask a question the client already closed on the real
      // account (2026-08-20; the same transactions are being copied below,
      // so the same per-bank month gaps recompute identically).
      coverage_answers: sourceCoverageAnswers,
    })
    .select('id')
    .single()
  if (wsErr) throw new Error(wsErr.message)

  // Copy the client's member roster into the workspace — from the SHARED
  // reader, not from the contact links alone.
  //
  // This fork used to read `account_contacts` only, which gave the accountant's
  // workspace a NARROWER roster than the client's own books. A company that is
  // a member exists only on the curated members list and can never be a contact
  // row, so it vanished here — and the workspace then re-booked that member's
  // draws as ordinary business expenses. Saving back flipped them again on the
  // client side: the exact flip-flop the shared roster exists to prevent, just
  // relocated to the staff surface. A third definition of "who is a member" is
  // never the answer.
  const { fetchMemberRoster } = await import('@/lib/tax/member-roster')
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('ownership_pct, contacts(first_name, last_name)')
    .eq('account_id', input.sourceAccountId)
  // Ownership percentages only exist on the contact links today, so they are
  // matched back by name; a roster name with no link simply has none, which the
  // draft already handles (it spreads unattributed movements by ownership and
  // flags them) rather than dropping the member.
  // Matched on the NORMALISED name (accents folded), because the curated list
  // and the contact link routinely spell the same person differently —
  // "Nicolò Patti" vs "Nicolo Patti". A raw lowercase key misses, the member
  // forks with no ownership %, and the accountant is then blocked by an
  // ownership gate on a company whose ownership is fully on file.
  const { normalizeForMatch, looksLikeCompany } = await import('@/lib/tax/member-names')
  const pctByName = new Map<string, number | null>()
  for (const l of ((links ?? []) as unknown as Array<{ ownership_pct: number | null; contacts: { first_name: string | null; last_name: string | null } | null }>)) {
    if (!l.contacts) continue
    const key = normalizeForMatch(`${l.contacts.first_name ?? ''} ${l.contacts.last_name ?? ''}`)
    if (!key) continue
    // Both spellings present with DIFFERENT percentages is ambiguous — record
    // nothing rather than let the last row silently decide a K-1 split. A
    // missing percentage is flagged by the ownership gate; a wrong one is not.
    if (pctByName.has(key) && pctByName.get(key) !== l.ownership_pct) { pctByName.set(key, null); continue }
    pctByName.set(key, l.ownership_pct)
  }
  const roster = await fetchMemberRoster(supabaseAdmin, input.sourceAccountId)
  const members: MemberInput[] = roster.names.map(name => ({
    // A company member forked as an individual misstates what it is.
    member_type: looksLikeCompany(name) ? 'company' : 'individual',
    display_name: name,
    ownership_pct: pctByName.get(normalizeForMatch(name)) ?? null,
  }))
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
