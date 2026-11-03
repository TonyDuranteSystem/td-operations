/**
 * CRON (every 3 minutes): reads Supabase's status feed and tells Antonio, Luca and Jodi ONCE when an incident that can hurt us opens and once when it is resolved.
 * Auth: Bearer CRON_SECRET (fails closed when the secret is not set). `?dry_run=1` lists what would be announced and sends / records nothing.
 * Docs: docs/systems/supabase-status.md
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { listTeamMembers } from '@/lib/team/directory'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'
import { fetchSupabaseFeed, supabaseRegion } from '@/lib/infra/supabase-status-server'
import { NOTICE_RECIPIENT_EMAILS, runStatusNotices, type NoticeStore } from '@/lib/infra/supabase-status-notify'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = () => (supabaseAdmin as any).from('infra_incident_notices')

const store: NoticeStore = {
  async claimOpened(i) {
    const { data, error } = await table().insert({ incident_id: i.id, title: i.title, opened_notified_at: new Date().toISOString() }).select('incident_id')
    if (error) {
      if ((error as { code?: string }).code === '23505') return false // already announced
      throw new Error(error.message)
    }
    return Array.isArray(data) && data.length > 0
  },
  async claimResolved(i) {
    const now = new Date().toISOString()
    const { data, error } = await table().update({ resolved_notified_at: now, updated_at: now }).eq('incident_id', i.id).is('resolved_notified_at', null).not('opened_notified_at', 'is', null).select('incident_id')
    if (error) throw new Error(error.message)
    return Array.isArray(data) && data.length > 0
  },
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = ['1', 'true'].includes(req.nextUrl.searchParams.get('dry_run') ?? '')
  const startTime = Date.now()
  try {
    const feed = await fetchSupabaseFeed({ fresh: true })
    if (!feed) {
      // the feed could not be read: say nothing (never an all-clear) and try again in three minutes
      logCron({ endpoint: 'supabase-status', status: 'success', duration_ms: Date.now() - startTime, details: { feed: 'unreadable' } })
      return NextResponse.json({ success: true, feed: 'unreadable' })
    }
    const wanted = new Set(NOTICE_RECIPIENT_EMAILS)
    const send = async (n: { title: string; body: string; tag: string }): Promise<number> => {
      const ids = (await listTeamMembers()).filter(m => m.email && wanted.has(m.email.toLowerCase())).map(m => m.id)
      // dm: true = a person with TD Talk installed is told there, everybody else in the CRM app (once each, never twice)
      const r = await sendPushToAdminUsers(ids, { title: n.title, body: n.body, url: '/', tag: n.tag, dm: true })
      return r?.sent ?? 0
    }
    const r = await runStatusNotices({ feed, region: supabaseRegion(), now: Date.now(), store, send, dryRun })
    logCron({ endpoint: 'supabase-status', status: 'success', duration_ms: Date.now() - startTime, details: { ...r, dryRun } })
    return NextResponse.json({ success: true, dryRun, ...r })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'supabase-status', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
