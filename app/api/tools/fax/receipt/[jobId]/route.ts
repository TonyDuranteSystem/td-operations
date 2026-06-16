/**
 * GET /api/tools/fax/receipt/[jobId] — download the Faxage transmittal page
 * (the PDF "receipt" a fax machine would print) for a completed sent fax.
 *
 * Staff-only (dashboard auth). Credentials come from env (FAXAGE_*), never the
 * client. Uses Faxage's `dltrans` operation via lib/fax/faxage.ts.
 *
 * On success → streams a PDF (inline by default; ?download=1 forces a save).
 * On failure (job not completed yet = ERR28, bad creds = ERR02, etc.) → a JSON
 * error so the caller can surface the reason.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { getFaxTransmittal } from '@/lib/fax/faxage'

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const jobId = (params.jobId || '').trim()
  if (!/^\d+$/.test(jobId)) {
    return NextResponse.json({ error: 'A numeric fax job ID is required.' }, { status: 400 })
  }

  const username = process.env.FAXAGE_USERNAME
  const password = process.env.FAXAGE_PASSWORD
  const company = process.env.FAXAGE_COMPANY || username || ''
  if (!username || !password) {
    return NextResponse.json(
      { error: 'Fax service is not configured (missing FAXAGE credentials).' },
      { status: 500 },
    )
  }

  let result
  try {
    result = await getFaxTransmittal({ username, company, password }, jobId)
  } catch (e) {
    console.error('[fax] receipt request failed (network/parse):', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to reach the fax service.' },
      { status: 502 },
    )
  }

  if (!result.ok || !result.pdf) {
    const low = (result.error || '').toLowerCase()
    let error: string
    if (low.includes('login incorrect') || low.startsWith('err02')) {
      error = `Faxage login failed — verify FAXAGE_USERNAME / FAXAGE_PASSWORD / FAXAGE_COMPANY in the Vercel env. Faxage said: ${(result.error || '').slice(0, 200)}`
    } else if (low.startsWith('err28') || low.includes('does not exist')) {
      error = 'No receipt is available yet — the transmittal page only exists once the fax has finished sending. Try again shortly.'
    } else {
      error = `Could not retrieve the fax receipt: ${(result.error || 'unknown error').slice(0, 300)}`
    }
    return NextResponse.json({ error }, { status: 502 })
  }

  const download = req.nextUrl.searchParams.get('download') === '1'
  const disposition = `${download ? 'attachment' : 'inline'}; filename="fax-receipt-${jobId}.pdf"`

  return new NextResponse(new Uint8Array(result.pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': disposition,
      'Cache-Control': 'private, no-store',
    },
  })
}
