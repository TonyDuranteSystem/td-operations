/**
 * POST /api/portal/tax-financials/prior-return
 *
 * TWO request shapes, same endpoint (the shared review component posts both
 * to this one URL depending on which control fired):
 *  - multipart { account_id, tax_year, file } — standalone upload of the
 *    prior-year filed return (PDF). Reuses the SAME extractor the wizard uses
 *    (`extractPriorReturn` → Schedule L / K-1 ending balances) and stores the
 *    result where `getFinancialsView` reads it
 *    (`tax_return_submissions.prior_return_extracted`) so this year's
 *    beginning balances carry forward correctly (IRS 1065 continuity).
 *  - JSON { choice: 'first_year' | 'never_filed' | 'clear' } — the staff
 *    quick-answer buttons on Gate 2 (2026-08-22, round-4 bug-hunter major
 *    finding). This route only ever implemented the multipart shape, so the
 *    JSON POST the buttons actually send hit `req.formData()`, which throws
 *    on a JSON body — every click 400'd silently, forever, for any real
 *    account viewed via staff Recall. The identical buttons already worked
 *    correctly against the workspace twin (app/api/tools/pnl/[id]/prior-
 *    return/route.ts), which implements this exact JSON contract — ported
 *    the same record-building logic here via the SAME shared, already-
 *    generic functions that route uses (lib/tax/workspace-prior-return.ts;
 *    genuinely account-agnostic despite the filename — confirmed by reading
 *    it before reusing it, not assumed from the name).
 *
 * For a client who never ran the wizard there's no submission row, so a
 * minimal completed one is created — verified side-effect-free (no DB
 * triggers; the tax board + What's New are SD-anchored / review_status-keyed,
 * and this row has neither).
 *
 * Owner OR staff (isAccountOwner passes non-client roles) — the JSON choice
 * buttons are staff-only in the UI (gated on isStaff in the shared review
 * component), same access model as the existing PDF-upload path.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { sha256Hex } from '@/lib/tax/statement-uploads'
import { buildWorkspacePriorReturnRecord, canStaffSetPriorReturn, type WorkspacePriorReturnChoice } from '@/lib/tax/workspace-prior-return'
import { resolveClientSubmission } from '@/lib/tax/resolve-submission'
import type { PriorReturnCaseRecord } from '@/lib/tax/prior-return-case'
import type { User } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

async function setChoice(req: NextRequest, user: User) {
  const body = await req.json().catch(() => ({})) as { account_id?: string; tax_year?: number; choice?: string }
  const accountId = String(body.account_id ?? '').trim()
  const taxYear = Number(body.tax_year)
  const choice = body.choice
  if (!accountId || !Number.isInteger(taxYear)) {
    return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
  }
  if (choice !== 'first_year' && choice !== 'never_filed' && choice !== 'clear') {
    return NextResponse.json({ error: "choice must be 'first_year', 'never_filed', or 'clear'." }, { status: 400 })
  }
  if (!(await isAccountOwner(user, accountId))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const existingSub = await resolveClientSubmission<{ id: string; prior_return_extracted: PriorReturnCaseRecord | null }>(
    db, accountId, taxYear, 'id, prior_return_extracted',
  )
  const existing = existingSub?.prior_return_extracted ?? null
  if (!canStaffSetPriorReturn(existing)) {
    return NextResponse.json({ error: 'This account carries an extracted prior return — its answer cannot be replaced from here.' }, { status: 409 })
  }

  let record: PriorReturnCaseRecord | null = null
  if (choice !== 'clear') {
    const { data: acct } = await db.from('accounts').select('formation_date').eq('id', accountId).maybeSingle()
    record = buildWorkspacePriorReturnRecord({
      choice: choice as WorkspacePriorReturnChoice,
      taxYear,
      formationDate: (acct?.formation_date as string | null) ?? null,
      actor: user?.email ?? 'staff',
    })
  }

  if (existingSub?.id) {
    const { error } = await db.from('tax_return_submissions').update({ prior_return_extracted: record }).eq('id', existingSub.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await db.from('tax_return_submissions').insert({
      account_id: accountId,
      tax_year: taxYear,
      status: 'completed',
      token: `staff-prior-choice-${accountId}-${taxYear}`,
      submitted_data: {},
      prior_return_extracted: record,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, prior_return: record ? { case: record.case, status: record.status } : null })
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    return setChoice(req, user)
  }

  let form: FormData
  try { form = await req.formData() } catch { return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 }) }

  const accountId = String(form.get('account_id') || '').trim()
  const taxYear = Number(form.get('tax_year'))
  const file = form.get('file')
  if (!accountId || !Number.isInteger(taxYear)) {
    return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
  }
  if (!(await isAccountOwner(user, accountId))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'Attach the prior-year return PDF.' }, { status: 400 })
  }
  if (!(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
    return NextResponse.json({ error: 'The prior-year return must be a PDF.' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const sha = sha256Hex(buffer)
  const path = `tax/${accountId}/${taxYear}/prior_year_return_${sha.slice(0, 16)}.pdf`

  const { error: upErr } = await supabaseAdmin.storage
    .from('onboarding-uploads')
    .upload(path, buffer, { contentType: 'application/pdf', upsert: true })
  if (upErr) return NextResponse.json({ error: `Could not save the file: ${upErr.message}` }, { status: 500 })

  const { data: acct } = await supabaseAdmin.from('accounts').select('ein_number').eq('id', accountId).single()
  const { extractPriorReturn } = await import('@/lib/tax/prior-return-extract')
  const result = await extractPriorReturn(buffer, `upload:${path}`, { priorYear: taxYear - 1, ein: (acct as { ein_number?: string | null } | null)?.ein_number ?? null })

  const now = new Date().toISOString()
  const record = result.status === 'failed'
    ? { case: 'filed_elsewhere', status: 'failed', error: result.error, recorded_at: now }
    : { ...result, case: 'filed_elsewhere' }

  // Store where getFinancialsView reads it (latest COMPLETED submission for the
  // account+year; create a minimal one if none exists). prior_return_extracted
  // is not yet in database.types — untyped-client pattern (same as prior-return-case.ts).
  // Same resolver as the rest of tax-financials (2026-08-03): the old
  // `status='completed'` filter missed every `reviewed` row, so this INSERTED a
  // duplicate placeholder submission instead of updating the client's real one.
  const existing = await resolveClientSubmission<{ id: string }>(db, accountId, taxYear, 'id')

  if (existing) {
    await db.from('tax_return_submissions').update({ prior_return_extracted: record }).eq('id', existing.id)
  } else {
    await db.from('tax_return_submissions').insert({
      account_id: accountId,
      tax_year: taxYear,
      status: 'completed',
      token: `staff-prior-${accountId}-${taxYear}-${sha.slice(0, 8)}`,
      submitted_data: {},
      prior_return_extracted: record,
    })
  }

  const message = result.status === 'failed'
    ? `Could not read the return: ${result.error}`
    : result.status === 'validated'
      ? 'Prior-year return read — beginning balances will carry forward.'
      : 'Uploaded, but the return needs manual review (extraction not verified).'
  return NextResponse.json({ status: result.status, message })
}
