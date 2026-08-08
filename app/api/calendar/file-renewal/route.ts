import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fileRenewal, type RenewalKind } from '@/lib/operations/file-renewal'

export const dynamic = 'force-dynamic'

/**
 * POST /api/calendar/file-renewal
 *
 * Multipart form-data endpoint for the CRM Calendar's Mark Filed dialog.
 * Parses the receipt File, then delegates to fileRenewal which does the
 * atomic Drive upload + completeSD + deadlines sync + portal notification
 * + accounts.notes append.
 *
 * Auth: requires a logged-in dashboard user (createClient from server).
 *
 * Dev task: 8efb34e5-dcf1-4a66-8b95-fe8c9a67addb
 */
export async function POST(req: NextRequest) {
  try {
    // Auth gate — only authenticated dashboard users may file renewals
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const fd = await req.formData()
    const account_id = fd.get('account_id')
    const kind = fd.get('kind')
    const filed_date = fd.get('filed_date')
    const delivery_id = fd.get('delivery_id')
    const receipt = fd.get('receipt')

    if (typeof account_id !== 'string' || !account_id) {
      return NextResponse.json({ error: 'account_id is required' }, { status: 400 })
    }
    if (kind !== 'ra' && kind !== 'ar') {
      return NextResponse.json({ error: 'kind must be "ra" or "ar"' }, { status: 400 })
    }
    if (typeof filed_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(filed_date)) {
      return NextResponse.json({ error: 'filed_date must be YYYY-MM-DD' }, { status: 400 })
    }
    if (!(receipt instanceof File)) {
      return NextResponse.json({ error: 'Receipt PDF is required.' }, { status: 400 })
    }
    if (receipt.type && !receipt.type.includes('pdf')) {
      return NextResponse.json(
        { error: `Receipt must be a PDF. Detected type: ${receipt.type}` },
        { status: 400 },
      )
    }
    if (receipt.size === 0) {
      return NextResponse.json({ error: 'Receipt file is empty.' }, { status: 400 })
    }
    // Reasonable upper bound — receipts are usually <1 MB; allow up to 25 MB.
    const MAX_BYTES = 25 * 1024 * 1024
    if (receipt.size > MAX_BYTES) {
      const mb = (receipt.size / (1024 * 1024)).toFixed(1)
      return NextResponse.json(
        { error: `Receipt too large (${mb} MB). Max is 25 MB.` },
        { status: 400 },
      )
    }

    // Optional: the cycle year this filing is FOR (early/late filings).
    const filingForYearRaw = fd.get('filing_for_year')
    let filing_for_year: number | null = null
    if (typeof filingForYearRaw === 'string' && filingForYearRaw !== '') {
      filing_for_year = parseInt(filingForYearRaw, 10)
      const filedYear = parseInt(filed_date.slice(0, 4), 10)
      // Stale records can be YEARS behind (the exact population this dialog
      // serves) — allow up to 10 years back; only 1 year forward (typo guard).
      if (Number.isNaN(filing_for_year) || filing_for_year > filedYear + 1 || filing_for_year < filedYear - 10) {
        return NextResponse.json(
          { error: 'filing_for_year must be between 10 years before and 1 year after the filed date' },
          { status: 400 },
        )
      }
    }

    const noteRaw = fd.get('note')
    const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim().slice(0, 2000) : null
    const override_unpaid = fd.get('override_unpaid') === 'true'
    if (override_unpaid && !note) {
      return NextResponse.json(
        { error: 'A note explaining why you are filing despite unpaid invoices is required.' },
        { status: 400 },
      )
    }

    const buffer = Buffer.from(await receipt.arrayBuffer())

    const result = await fileRenewal({
      account_id,
      delivery_id: typeof delivery_id === 'string' && delivery_id ? delivery_id : null,
      kind: kind as RenewalKind,
      filed_date,
      filing_for_year,
      note,
      override_unpaid,
      receipt: {
        file_name: receipt.name || 'receipt.pdf',
        mime_type: receipt.type || 'application/pdf',
        data: buffer,
      },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error ?? 'Failed to file renewal.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, ...result.data })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
