/**
 * POST /api/tools/fax/send — send a fax via the Faxage HTTPS API.
 *
 * Staff-only (dashboard auth). Accepts JSON:
 *   {
 *     faxno: string,                 // recipient fax number (formatting stripped)
 *     // ONE of the following two file sources:
 *     file_base64?: string,          // uploaded file (data: URI tolerated)
 *     file_name?: string,            // name for the uploaded file
 *     document_id?: string,          // a `documents` row → downloaded from Drive
 *     // optional metadata:
 *     cover_message?: string,        // logged; see note below
 *     recip_name?: string,
 *     account_id?: string,
 *     service_delivery_id?: string,
 *   }
 *
 * Credentials come from env (FAXAGE_USERNAME / FAXAGE_PASSWORD / FAXAGE_COMPANY)
 * — never from the client. The request shaping + response parsing live in
 * lib/fax/faxage.ts (unit-tested).
 *
 * NOTE on cover_message: the documented Faxage sendfax fields do not include a
 * cover-page message param we can rely on, so the message is recorded in
 * action_log but NOT transmitted. Wire it to the real Faxage cover param once
 * confirmed from their docs.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { downloadFileBinary } from '@/lib/google-drive'
import { sendFax, isValidFaxNo, normalizeFaxNo, DEFAULT_IRS_FAX_NUMBER } from '@/lib/fax/faxage'

const MAX_COVER_LENGTH = 2000

export async function POST(req: NextRequest) {
  // Staff auth — middleware lets logged-in clients reach /api, so gate here.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ success: false, error: 'Dashboard access required' }, { status: 403 })
  }

  const username = process.env.FAXAGE_USERNAME
  const password = process.env.FAXAGE_PASSWORD
  const company = process.env.FAXAGE_COMPANY || username || ''
  if (!username || !password) {
    return NextResponse.json(
      { success: false, error: 'Fax service is not configured (missing FAXAGE credentials).' },
      { status: 500 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const faxnoRaw: string = typeof body.faxno === 'string' ? body.faxno : ''
  const documentId: string | null = typeof body.document_id === 'string' && body.document_id.trim()
    ? body.document_id.trim()
    : null
  const coverMessage = typeof body.cover_message === 'string' ? body.cover_message.slice(0, MAX_COVER_LENGTH) : ''
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const recipName = typeof body.recip_name === 'string' && body.recip_name.trim() ? body.recip_name.trim() : undefined
  const serviceDeliveryId: string | null = typeof body.service_delivery_id === 'string' && body.service_delivery_id.trim()
    ? body.service_delivery_id.trim()
    : null

  // Validate the recipient number.
  if (!isValidFaxNo(faxnoRaw)) {
    return NextResponse.json(
      { success: false, error: 'A valid fax number (at least 10 digits) is required.' },
      { status: 400 },
    )
  }
  const faxno = normalizeFaxNo(faxnoRaw)

  // Resolve the file to send: either a selected document (downloaded from Drive)
  // or an uploaded base64 file from the client.
  let fileBase64 = ''
  let fileName = 'document.pdf'
  let accountId: string | null = typeof body.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : null

  if (documentId) {
    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, drive_file_id, account_id')
      .eq('id', documentId)
      .single()
    if (docErr || !doc) {
      return NextResponse.json({ success: false, error: 'Selected document not found.' }, { status: 404 })
    }
    if (!doc.drive_file_id) {
      return NextResponse.json(
        { success: false, error: 'That document has no stored file to fax.' },
        { status: 400 },
      )
    }
    try {
      const binary = await downloadFileBinary(doc.drive_file_id)
      fileBase64 = binary.buffer.toString('base64')
      fileName = doc.file_name || binary.fileName || 'document.pdf'
    } catch (e) {
      return NextResponse.json(
        { success: false, error: `Could not download the selected document: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      )
    }
    if (!accountId && doc.account_id) accountId = doc.account_id as string
  } else {
    fileBase64 = typeof body.file_base64 === 'string' ? body.file_base64 : ''
    fileName = typeof body.file_name === 'string' && body.file_name.trim() ? body.file_name.trim() : 'document.pdf'
    if (!fileBase64) {
      return NextResponse.json(
        { success: false, error: 'Attach a file or select a document to fax.' },
        { status: 400 },
      )
    }
  }

  // Send via Faxage.
  let result
  try {
    result = await sendFax({
      credentials: { username, company, password },
      faxno,
      fileName,
      fileBase64,
      recipName,
    })
  } catch (e) {
    console.error('[fax] Faxage request failed (network/parse):', e)
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Failed to reach the fax service.' },
      { status: 502 },
    )
  }

  if (!result.ok) {
    // Log the FULL raw Faxage response so the cause is visible in server logs.
    console.error('[fax] Faxage rejected the request. Raw response:', result.raw, '| faxno:', faxno, '| file:', fileName)
    // Faxage auth failures come back as "ERR02: Login incorrect" — surface a
    // credentials-specific message instead of a generic "rejected".
    const low = result.raw.toLowerCase()
    const isLogin = low.includes('login incorrect') || low.startsWith('err02') || low.includes('login failed')
    const error = isLogin
      ? `Faxage login failed — verify FAXAGE_USERNAME / FAXAGE_PASSWORD / FAXAGE_COMPANY in the Vercel env (these are the Faxage account's Company + Username, which are usually NOT the email). Faxage said: ${result.raw.slice(0, 200)}`
      : `Faxage rejected the request: ${result.raw.slice(0, 300) || 'unknown error'}`
    return NextResponse.json({ success: false, error }, { status: 502 })
  }

  // Audit trail (best-effort — never fail the send if logging fails).
  try {
    await supabaseAdmin.from('action_log').insert({
      actor: user?.email || 'dashboard',
      action_type: 'fax_sent',
      table_name: 'documents',
      record_id: documentId,
      account_id: accountId,
      service_delivery_id: serviceDeliveryId,
      summary: `Fax sent to ${faxno} — ${fileName}`,
      details: {
        faxno,
        recip_name: recipName || null,
        reason: reason || null,
        file_name: fileName,
        job_id: result.jobId,
        cover_message: coverMessage || null,
        source: documentId ? 'document' : 'upload',
        faxage_response: result.raw.slice(0, 500),
      },
    })
  } catch {
    /* logging is non-blocking */
  }

  return NextResponse.json({
    success: true,
    job_id: result.jobId,
    faxage_response: result.raw.slice(0, 500),
  })
}

/** Expose the configured IRS fax number to the staff fax UI (no secrets). */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }
  return NextResponse.json({ irs_fax_number: process.env.FAXAGE_IRS_NUMBER || DEFAULT_IRS_FAX_NUMBER })
}
