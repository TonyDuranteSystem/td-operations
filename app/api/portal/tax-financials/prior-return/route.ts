/**
 * POST /api/portal/tax-financials/prior-return — multipart { account_id, tax_year, file }
 *
 * Standalone upload of the prior-year filed return (PDF). Reuses the SAME
 * extractor the wizard uses (`extractPriorReturn` → Schedule L / K-1 ending
 * balances) and stores the result where `getFinancialsView` reads it
 * (`tax_return_submissions.prior_return_extracted`) so this year's beginning
 * balances carry forward correctly (IRS 1065 continuity). For a client who never
 * ran the wizard there's no submission row, so a minimal completed one is created
 * — verified side-effect-free (no DB triggers; the tax board + What's New are
 * SD-anchored / review_status-keyed, and this row has neither).
 *
 * Owner OR staff (isAccountOwner passes non-client roles).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { sha256Hex } from '@/lib/tax/statement-uploads'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: existing } = await db
    .from('tax_return_submissions')
    .select('id')
    .eq('account_id', accountId)
    .eq('tax_year', taxYear)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

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
