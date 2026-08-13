/**
 * POST /api/portal/tax-financials/upload — multipart
 *   file, account_id, tax_year, bank_name (free text), account_kind
 *
 * SAVE + ENQUEUE (async ingestion). The route is intentionally THIN: it
 * authenticates, validates, archives the raw file to storage, and enqueues ONE
 * `ingest_bank_statement` job — then kicks the worker and returns. The heavy
 * ingestion (parse → categorize → insert → full-year recategorization) runs in
 * that background job, NOT in the request.
 *
 * WHY (prod bug, 2026-06-26): the old route ran the full ingestion synchronously
 * in-request; on production that work outran the serverless function and Vercel
 * tore it down before responding → empty 500 ("No response is returned from
 * route handler") even though the rows ingested. Moving ingestion to a job (the
 * same path the wizard already uses) removes the entire class. The financials
 * view surfaces in-flight ingestion (`ingestPending`) and the client polls every
 * 20s, so transactions + P&L fill in as the job completes.
 *
 * OWNER-ONLY. Accepts CSV / PDF / ZIP statements.
 */

import { createClient } from '@/lib/supabase/server'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
// Thin save+enqueue now; kept generous purely for the bounded worker kick.
export const maxDuration = 60

const MAX_BYTES = 20 * 1024 * 1024 // 20 MB — covers a full-year CSV or PDF statement

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const form = await request.formData()
    const file = form.get('file') as File | null
    const accountId = String(form.get('account_id') ?? '')
    const taxYear = Number(form.get('tax_year'))
    const bankLabel = String(form.get('bank_name') ?? '').trim()
    // Account identity for this file (account_number-mode institutions). Optional at
    // the API — the client UI enforces it as required for banks; currency/crypto
    // services legitimately have none.
    const accountNumber = String(form.get('account_number') ?? '').trim() || null

    if (!file || !accountId || !Number.isInteger(taxYear) || !bankLabel) {
      return NextResponse.json({ error: 'file, account_id, tax_year and bank_name are required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // LOCK (added 2026-08-03, bug-hunter blocker). Deleting a statement was
    // already refused while the file is with our team, but UPLOADING one was
    // not — so a locked client could drop in a new CSV and shift the P&L
    // underneath the staff member reviewing it, with no refusal and no signal.
    // Same resolver as the GET's banner and every other write route.
    {
      const { supabaseAdmin } = await import('@/lib/supabase-admin')
      const { resolveEditability } = await import('@/lib/tax/resolve-submission')
      const { editable: canEdit } = await resolveEditability(supabaseAdmin, accountId, taxYear)
      if (!canEdit) {
        return NextResponse.json(
          { error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it before adding statements.' },
          { status: 409 },
        )
      }
    }

    if (!/\.(csv|pdf|zip)$/i.test(file.name)) {
      return NextResponse.json(
        { error: 'Please upload a CSV or PDF statement. Open your online banking, export this account\'s transactions for the entire year, and upload the CSV or the official PDF statement.' },
        { status: 400 },
      )
    }
    if (file.size === 0) {
      return NextResponse.json(
        { error: 'This file is empty. Please re-export the statement from your bank and upload it again.' },
        { status: 400 },
      )
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB — larger than the ${MAX_BYTES / 1024 / 1024} MB limit. A bank CSV export should be far smaller; please export CSV (not Excel) directly from your online banking.` },
        { status: 400 },
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const { saveAndEnqueueStatementUpload } = await import('@/lib/tax/portal-upload-enqueue')
    const result = await saveAndEnqueueStatementUpload({ accountId, taxYear, bankLabel, accountNumber, buffer, fileName: file.name })

    // The file SET changed the moment the upload was accepted — clear a stale
    // attestation AND any staff failed-files unlock NOW, not only when rows
    // later land (card 4a39e0fd round 3, bug-hunter blocker: an upload that
    // goes on to FAIL used to leave a prior staff unlock standing, so the
    // client could attest over a brand-new hole no staff ever judged).
    try {
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, `new file uploaded (${file.name})`)
    } catch (e) {
      console.error('[tax-financials/upload] attestation/override reset failed (upload saved):', e)
    }

    // Kick the worker so the file starts processing promptly. AWAITED + bounded
    // (triggerWorker has a 5s timeout) so it never dangles past the response —
    // an un-awaited trigger is exactly the teardown pattern we're removing. The
    // 5-min process-jobs cron drains it regardless if this kick is a no-op.
    try {
      const { triggerWorker } = await import('@/lib/jobs/queue')
      await triggerWorker()
    } catch {
      // best-effort — the cron is the safety net
    }

    return NextResponse.json({
      ok: true,
      queued: result.queued,
      alreadyQueued: result.alreadyQueued,
      fileName: file.name,
      // The content-hashed storage path — the client watches it so the W9
      // pop-up can announce THIS upload's outcome (and only this session's).
      path: result.path,
    })
  } catch (err) {
    console.error('[tax-financials] upload failed:', err)
    return NextResponse.json({ error: 'Upload failed on our side — please try again in a moment.' }, { status: 500 })
  }
}
