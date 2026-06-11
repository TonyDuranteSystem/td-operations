/**
 * POST /api/portal/tax-financials/upload — multipart
 *   file, account_id, tax_year, bank_name (free text), account_kind
 *
 * Instant-parse ingestion (master plan §3.3): parse by content signature →
 * categorize → duplicate alerts (L1/L2/L3) → source-keyed insert → live
 * feedback ("✓ Full year detected — 248 transactions, Jan–Dec"). The AI
 * categorization refinement runs in the background after the response.
 *
 * OWNER-ONLY. CSV only (same guard as the wizard upload routes).
 */

import { createClient } from '@/lib/supabase/server'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_BYTES = 20 * 1024 * 1024 // 20 MB — a full-year CSV is well under this

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
    const accountKind = String(form.get('account_kind') ?? 'checking')

    if (!file || !accountId || !Number.isInteger(taxYear) || !bankLabel) {
      return NextResponse.json({ error: 'file, account_id, tax_year and bank_name are required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    if (!/\.csv$/i.test(file.name)) {
      return NextResponse.json(
        { error: 'Please upload only CSV files. Open your online banking, export this account\'s transactions for the entire year, and choose CSV as the format.' },
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
    const { ingestPortalCsv } = await import('@/lib/tax/portal-csv-ingest')
    const result = await ingestPortalCsv({ accountId, taxYear, bankLabel, accountKind, buffer, fileName: file.name })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 })

    // Keep the raw CSV (content-hash named) so the accountant package can
    // archive the original exports — fire-and-forget, ingestion already done.
    if (result.inserted > 0) {
      const { supabaseAdmin } = await import('@/lib/supabase-admin')
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      void supabaseAdmin.storage
        .from('onboarding-uploads')
        .upload(`tax/${accountId}/financials_${result.sourceFileId.replace('upload:', '')}_${safeName}`, buffer, { contentType: 'text/csv', upsert: true })
        .then(({ error }) => { if (error) console.error('[tax-financials] raw CSV archive failed:', error.message) })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[tax-financials] upload failed:', err)
    return NextResponse.json({ error: 'Upload failed on our side — please try again in a moment.' }, { status: 500 })
  }
}
