/**
 * POST /api/tools/fax/send — send a fax via the Faxage HTTPS API.
 *
 * Staff-only (dashboard auth). Body (JSON):
 *   { faxno: string, file_base64: string, file_name: string, cover_message?: string }
 *
 * Credentials come from env (FAXAGE_USERNAME / FAXAGE_PASSWORD) — never from the
 * client. Posts application/x-www-form-urlencoded to Faxage's httpsfax.php with
 * operation=sendfax.
 *
 * NOTE (unverified): Faxage's documented sendfax also accepts `company` (the
 * account number) and `recipname`. We send what we have + recipname + the file
 * name/data. If Faxage rejects with a missing-param error, add FAXAGE_COMPANY to
 * env and include it below.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'

const FAXAGE_URL = 'https://www.faxage.com/httpsfax.php'
const MAX_COVER_LENGTH = 2000

/** Keep only digits — Faxage wants a bare number (e.g. 18005551234). */
function normalizeFaxNo(raw: string): string {
  return raw.replace(/[^\d]/g, '')
}

export async function POST(req: NextRequest) {
  // Staff auth
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const username = process.env.FAXAGE_USERNAME
  const password = process.env.FAXAGE_PASSWORD
  if (!username || !password) {
    return NextResponse.json(
      { success: false, error: 'Fax service is not configured (missing FAXAGE credentials).' },
      { status: 500 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const faxnoRaw = typeof body.faxno === 'string' ? body.faxno : ''
  const fileBase64 = typeof body.file_base64 === 'string' ? body.file_base64 : ''
  const fileName = typeof body.file_name === 'string' && body.file_name.trim() ? body.file_name.trim() : 'document.pdf'
  const coverMessage = typeof body.cover_message === 'string' ? body.cover_message.slice(0, MAX_COVER_LENGTH) : ''
  const recipName = typeof body.recip_name === 'string' && body.recip_name.trim() ? body.recip_name.trim() : 'Recipient'

  const faxno = normalizeFaxNo(faxnoRaw)
  if (!faxno || faxno.length < 10) {
    return NextResponse.json({ success: false, error: 'A valid fax number (at least 10 digits) is required.' }, { status: 400 })
  }
  if (!fileBase64) {
    return NextResponse.json({ success: false, error: 'A file to fax is required.' }, { status: 400 })
  }

  // Faxage expects raw base64 (no data: URI prefix).
  const faxfiledata = fileBase64.includes(',') ? fileBase64.slice(fileBase64.indexOf(',') + 1) : fileBase64

  const params = new URLSearchParams({
    operation: 'sendfax',
    username,
    password,
    recipname: recipName,
    faxno,
    faxfilenames: fileName,
    faxfiledata,
  })
  if (coverMessage.trim()) params.set('faxcoverpage', '1')
  // Optional account number — only sent if configured (Faxage "company" field).
  if (process.env.FAXAGE_COMPANY) params.set('company', process.env.FAXAGE_COMPANY)

  try {
    const res = await fetch(FAXAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const text = await res.text()

    // Faxage returns a plain-text status string. Treat an explicit error token as a failure.
    const lower = text.toLowerCase()
    const looksLikeError = !res.ok || lower.includes('error') || lower.includes('invalid') || lower.includes('fail')
    if (looksLikeError) {
      return NextResponse.json(
        { success: false, error: `Faxage rejected the request: ${text.slice(0, 300) || `HTTP ${res.status}`}` },
        { status: 502 },
      )
    }

    return NextResponse.json({ success: true, faxage_response: text.slice(0, 500) })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Failed to reach the fax service.' },
      { status: 502 },
    )
  }
}
