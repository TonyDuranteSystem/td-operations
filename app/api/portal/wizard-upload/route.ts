/**
 * POST /api/portal/wizard-upload — Upload a file from the wizard to Supabase Storage
 * Uses the same bucket pattern as external forms: {wizard_type}-uploads/{identifier}/{filename}
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'

const BUCKET = 'onboarding-uploads' // Shared bucket for all wizard uploads

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const fieldName = formData.get('field_name') as string
    const wizardType = formData.get('wizard_type') as string
    const identifier = formData.get('identifier') as string || user.email || user.id

    if (!file || !fieldName) {
      return NextResponse.json({ error: 'file and field_name required' }, { status: 400 })
    }

    // CSV-only guard for the tax per-bank statement sections (master plan
    // b2115fd3 §2.1) — same rule as wizard-upload-url.
    if (/^bank_accounts_\d+_statements$/.test(fieldName) && !/\.csv$/i.test(file.name)) {
      return NextResponse.json(
        { error: 'Please upload only CSV files. Open your online banking, export this account\'s transactions for the entire year, and choose CSV as the format.' },
        { status: 400 },
      )
    }

    // PDF-only guard for the prior-year return (master plan §5 Case B) —
    // same rule as wizard-upload-url.
    // Crypto follow-ups (§14): the 1099 is a PDF tax form; the exchange
    // transaction export follows the same CSV-only rule as the banks.
    if (fieldName === 'comp_digital_assets_1099_file' && !/\.pdf$/i.test(file.name)) {
      return NextResponse.json(
        { error: 'Please upload the 1099 / 1099-DA as a PDF — you find it in your exchange\'s Tax Documents section.' },
        { status: 400 },
      )
    }
    if (fieldName === 'comp_digital_assets_csv' && !/\.csv$/i.test(file.name)) {
      return NextResponse.json(
        { error: 'Please upload the exchange transaction export as a CSV file — the entire year, same rule as your bank accounts.' },
        { status: 400 },
      )
    }

    if (fieldName === 'prior_year_return' && !/\.pdf$/i.test(file.name)) {
      return NextResponse.json(
        { error: 'Please upload the filed tax return as a PDF — the complete document with all pages, including Schedule L and every K-1.' },
        { status: 400 },
      )
    }

    // Build storage path: {wizard_type}/{identifier}/{fieldName}_{filename}
    const sanitizedId = identifier.replace(/[^a-zA-Z0-9@._-]/g, '_')
    const storagePath = `${wizardType || 'wizard'}/${sanitizedId}/${fieldName}_${file.name}`

    // Upload to Supabase Storage
    const arrayBuffer = await file.arrayBuffer()
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, arrayBuffer, {
        contentType: file.type,
        upsert: true, // overwrite if same file uploaded again
      })

    if (uploadError) {
      console.error('[wizard-upload] Upload error:', uploadError.message)
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    return NextResponse.json({ path: storagePath, bucket: BUCKET })
  } catch (err) {
    console.error('[wizard-upload] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
