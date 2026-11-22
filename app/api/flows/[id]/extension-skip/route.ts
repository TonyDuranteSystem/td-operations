/**
 * POST /api/flows/[id]/extension-skip — "No extension needed" for a Tax Return job whose tax form is already open, and its undo
 * (Antonio, 22 Nov 2026, dev job 6f555c9f). Body: { skip: true | false }.
 *
 * The choice is written on the tax record of the job's year (extension_skipped_at + extension_skipped_by) and in the activity log (who, when), so it
 * is never silent, and it is UNDOABLE. The Exceptions list stops flagging a skipped extension; a delivered extension fax clears it again.
 * Every refusal (wrong step, already filed, a fax on its way, no tax record) is decided by the pure rule `decideExtensionSkip` in
 * lib/fax/extension-fax.ts and comes back as a plain sentence.
 *
 * Staff-only. [id] = service_delivery_id. A lookup that fails is an error (503), never "nothing to refuse".
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { taxReturnYear } from '@/lib/flows/resolve-flows'
import { pickTaxRecordForPipeline } from '@/lib/tax/pick-tax-record'
import type { FaxLogRow, MarkerRow } from '@/lib/fax/return-fax'
import { buildExtensionFaxState, decideExtensionSkip, EXTENSION_FAX_MARKERS, EXTENSION_FAX_PURPOSE } from '@/lib/fax/extension-fax'

const NOT_CHECKED = 'Could not check this job. Nothing was changed. Please reload and try again.'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ success: false, error: 'Dashboard access required' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as { skip?: unknown } | null
  if (!body || typeof body.skip !== 'boolean') {
    return NextResponse.json({ success: false, error: 'Say whether to skip the extension (skip: true) or undo it (skip: false).' }, { status: 400 })
  }
  const skip = body.skip
  const sdId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_deliveries / action_log / tax_returns columns are not all in the generated types
  const db = supabaseAdmin as any

  const sdRes = await db
    .from('service_deliveries')
    .select('id, account_id, service_type, stage, status, due_date, created_at, stage_entered_at')
    .eq('id', sdId)
    .maybeSingle()
  if (sdRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const sd = sdRes.data
  if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
  if (sd.service_type !== 'Tax Return') return NextResponse.json({ success: false, error: 'This belongs to a Tax Return job.' }, { status: 400 })
  const accountId = (sd.account_id as string | null) ?? null
  if (!accountId) return NextResponse.json({ success: false, error: 'This job has no company yet, so it has no tax record to mark.' }, { status: 409 })

  // the tax record of this job's year (the "skipped" columns may be missing on an older database: choosing is then impossible, undoing is a no-op)
  let trRes = await db.from('tax_returns').select('id, status, tax_year, extension_filed, extension_skipped_at').eq('account_id', accountId)
  let columnsMissing = false
  if (trRes.error && /extension_skipped/.test(trRes.error.message ?? '')) {
    columnsMissing = true
    trRes = await db.from('tax_returns').select('id, status, tax_year, extension_filed').eq('account_id', accountId)
  }
  if (trRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const rows = (trRes.data ?? []) as Array<{ id: string; status: string | null; tax_year: number | null; extension_filed?: boolean | null; extension_skipped_at?: string | null }>
  const picked = pickTaxRecordForPipeline(rows, taxReturnYear(sd))
  const row = picked.kind === 'record' ? rows.find((r) => r.id === picked.row.id) ?? null : null

  // a Form 7004 fax of this job that could still file the extension (sent, never confirmed, or delivered to a number nobody confirmed yet)
  const acc = await db.from('accounts').select('entity_type').eq('id', accountId).maybeSingle()
  if (acc.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const faxRes = await db
    .from('action_log')
    .select('id, action_type, created_at, details')
    .eq('service_delivery_id', sdId)
    .in('action_type', ['fax_sent', 'fax_claim'])
    .eq('details->>purpose', EXTENSION_FAX_PURPOSE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (faxRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const markerRes = await db
    .from('action_log')
    .select('action_type, created_at, details')
    .eq('service_delivery_id', sdId)
    .in('action_type', Object.values(EXTENSION_FAX_MARKERS).filter((k) => k !== EXTENSION_FAX_MARKERS.filingClaim))
    .order('created_at', { ascending: false })
    .limit(20)
  if (markerRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const faxState = buildExtensionFaxState({
    entityType: (acc.data?.entity_type as string | null | undefined) ?? null,
    workingCopy: null,
    latestFax: (faxRes.data as FaxLogRow | null) ?? null,
    markers: (markerRes.data ?? []) as MarkerRow[],
  })
  const faxInProgress = faxState.mode === 'sent' || faxState.mode === 'unconfirmed' || faxState.mode === 'confirm_recipient'

  if (skip && columnsMissing) {
    return NextResponse.json({ success: false, error: 'The database is not ready for this choice yet (its column is missing). Nothing was changed.' }, { status: 503 })
  }
  const decision = decideExtensionSkip({
    stage: sd.stage as string | null,
    status: sd.status as string | null,
    hasRecord: !!row,
    extensionFiled: row?.extension_filed === true,
    alreadySkipped: !!row?.extension_skipped_at,
    faxInProgress,
    skip,
  })
  if (!decision.ok) return NextResponse.json({ success: false, error: decision.error ?? 'This choice is not allowed here.' }, { status: 409 })
  if (decision.noop || !row) {
    return NextResponse.json({ success: true, skipped: skip, changed: false })
  }

  const who = (user?.email as string | undefined) ?? 'staff'
  const nowIso = new Date().toISOString()
  const { error: upErr } = await db
    .from('tax_returns')
    .update({ extension_skipped_at: skip ? nowIso : null, extension_skipped_by: skip ? who : null, updated_at: nowIso })
    .eq('id', row.id)
  if (upErr) return NextResponse.json({ success: false, error: `Could not save the choice: ${upErr.message}. Nothing was changed.` }, { status: 500 })

  // who and when, so the choice is never silent (a failed log line is reported, the choice itself already stands)
  const { error: logErr } = await db.from('action_log').insert({
    actor: who,
    action_type: skip ? 'extension_skipped' : 'extension_skip_undone',
    table_name: 'tax_returns',
    record_id: row.id,
    account_id: accountId,
    service_delivery_id: sdId,
    summary: skip ? `No extension needed — marked by ${who}` : `"No extension needed" undone by ${who}`,
    details: { stage: sd.stage, tax_year: picked.kind === 'record' ? picked.row.tax_year : null },
  })
  return NextResponse.json({
    success: true,
    skipped: skip,
    changed: true,
    skipped_at: skip ? nowIso : null,
    skipped_by: skip ? who : null,
    ...(logErr ? { warning: `The choice is saved, but its history line could not be written: ${logErr.message}` } : {}),
  })
}
