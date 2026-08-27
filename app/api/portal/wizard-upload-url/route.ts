/**
 * POST /api/portal/wizard-upload-url — Mint the storage PATH for a wizard file
 * upload. The browser then uploads the file DIRECTLY to Supabase Storage
 * (resumable TUS), bypassing this serverless function entirely.
 *
 * Why server-minted path: the server owns the path scheme + uniqueness so every
 * downstream consumer still matches files by field name. The browser supplies
 * the bytes straight to storage (authenticated with the client's own session
 * token), so there's no ~4.5MB Vercel request-body cap and large uploads can
 * resume after a network interruption. dev_task 64bfcdd9.
 *
 * Path scheme (unchanged):
 *   {wizardType}/{identifier}/{fieldName}_{unique}_{filename}
 * The {unique} segment lets one field hold multiple files without colliding.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/auth'
import { WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES, wizardUploadTooLargeMessage } from '@/lib/portal/wizard-uploads'

const BUCKET = 'onboarding-uploads' // Shared bucket for all wizard uploads

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const fieldName = body.field_name as string
    const fileName = body.file_name as string
    const fileSize = typeof body.file_size === 'number' ? body.file_size : undefined
    const wizardType = body.wizard_type as string
    const identifier = (body.identifier as string) || user.email || user.id

    if (!fieldName || !fileName) {
      return NextResponse.json({ error: 'field_name and file_name are required' }, { status: 400 })
    }

    // The browser already checks this before calling here — this is the
    // authoritative check (the browser check can be skipped/bypassed).
    if (fileSize !== undefined && fileSize > WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: wizardUploadTooLargeMessage(fileSize) }, { status: 400 })
    }

    // CSV or PDF guard for the tax per-bank statement sections (master plan
    // b2115fd3 §2.1; PDF added 2026-06-25 — the AI extractor reads PDFs too).
    // The server must not trust the client accept filter; a wrong file is still
    // rejected later at parse time, this stops the obvious case with guidance.
    if (/^bank_accounts_\d+_statements$/.test(fieldName) && !/\.(csv|pdf)$/i.test(fileName)) {
      return NextResponse.json(
        { error: 'Please upload your bank statement as a CSV export or the official PDF statement, for the entire year. Open your online banking, export the full year, and choose CSV — or download the PDF statements.' },
        { status: 400 },
      )
    }

    // PDF-only guard for the prior-year return (master plan §5 Case B) — a
    // filed return is a PDF; anything else cannot be read for Schedule L.
    // Crypto follow-ups (§14): the 1099 is a PDF tax form; the exchange
    // transaction export follows the same CSV-only rule as the banks.
    if (fieldName === 'comp_digital_assets_1099_file' && !/\.pdf$/i.test(fileName)) {
      return NextResponse.json(
        { error: 'Please upload the 1099 / 1099-DA as a PDF — you find it in your exchange\'s Tax Documents section.' },
        { status: 400 },
      )
    }
    if (fieldName === 'comp_digital_assets_csv' && !/\.csv$/i.test(fileName)) {
      return NextResponse.json(
        { error: 'Please upload the exchange transaction export as a CSV file — the entire year, same rule as your bank accounts.' },
        { status: 400 },
      )
    }

    if (fieldName === 'prior_year_return' && !/\.pdf$/i.test(fileName)) {
      return NextResponse.json(
        { error: 'Please upload the filed tax return as a PDF — the complete document with all pages, including Schedule L and every K-1.' },
        { status: 400 },
      )
    }

    const sanitizedId = String(identifier).replace(/[^a-zA-Z0-9@._-]/g, '_')
    const sanitizedFile = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')
    const unique = randomUUID().slice(0, 8)
    const storagePath = `${wizardType || 'wizard'}/${sanitizedId}/${fieldName}_${unique}_${sanitizedFile}`

    return NextResponse.json({ path: storagePath, bucket: BUCKET })
  } catch (err) {
    console.error('[wizard-upload-url] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create upload path' },
      { status: 500 },
    )
  }
}
