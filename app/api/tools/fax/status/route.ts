/**
 * GET /api/tools/fax/status?jobId=NNN — poll Faxage for the live delivery
 * status of a previously-sent fax (or all jobs when jobId is omitted).
 *
 * Staff-only (dashboard auth). Credentials come from env (FAXAGE_*), never the
 * client. The request shaping + response parsing live in lib/fax/faxage.ts.
 *
 * NOTE: action_log is the source of fax HISTORY (rows are written at send time
 * by /api/tools/fax/send). This route adds LIVE delivery status on demand —
 * Faxage's `status` operation is the authoritative source for delivered /
 * pending / failed, page count and transmit time.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { getFaxStatus } from '@/lib/fax/faxage'

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
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

  const jobId = req.nextUrl.searchParams.get('jobId')?.trim() || undefined

  let result
  try {
    result = await getFaxStatus({ username, company, password }, { jobId })
  } catch (e) {
    console.error('[fax] status request failed (network/parse):', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to reach the fax service.' },
      { status: 502 },
    )
  }

  if (!result.ok) {
    const low = (result.error || '').toLowerCase()
    const isLogin = low.includes('login incorrect') || low.startsWith('err02')
    const error = isLogin
      ? `Faxage login failed — verify FAXAGE_USERNAME / FAXAGE_PASSWORD / FAXAGE_COMPANY in the Vercel env. Faxage said: ${(result.error || '').slice(0, 200)}`
      : `Faxage rejected the status request: ${(result.error || 'unknown error').slice(0, 300)}`
    return NextResponse.json({ error }, { status: 502 })
  }

  // Persist the live status onto the matching action_log row so Fax History
  // shows it on page load without re-checking. Best-effort + non-blocking: a
  // failure here never affects the response. Only when a specific jobId was
  // requested and a meaningful (non-unknown) record came back. The details JSON
  // is MERGED (other fields preserved); matched by details->>job_id.
  const rec = result.records[0]
  if (jobId && rec && rec.status !== 'unknown') {
    try {
      const { data: matches } = await supabaseAdmin
        .from('action_log')
        .select('id, details')
        .eq('action_type', 'fax_sent')
        .eq('details->>job_id', jobId)
        .limit(1)
      const row = matches?.[0]
      if (row) {
        const details = (row.details ?? {}) as Record<string, unknown>
        await supabaseAdmin
          .from('action_log')
          .update({
            details: {
              ...details,
              fax_status: {
                status: rec.status,
                pages: rec.pageCount || null,
                xmit_time: rec.xmitTime || null,
                complete_time: rec.completeTime || null,
                checked_at: new Date().toISOString(),
              },
            },
          })
          .eq('id', row.id)
      }
    } catch (e) {
      console.error('[fax] persist status to action_log failed (non-blocking):', e)
    }
  }

  return NextResponse.json({ records: result.records })
}
