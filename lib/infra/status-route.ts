/**
 * The one handler behind the three addresses of the Supabase-status route — one per door rule (a marketing login may only call /api/marketing/*,
 * a client only /api/portal/*; see lib/auth/role-door.ts and lib/auth/client-api-allowlist.ts):
 *   /api/infra/supabase-status, /api/marketing/supabase-status, /api/portal/supabase-status.
 *  - TD staff and the TD Marketing team get the details, in Supabase's own words ({ audience: "staff", incident }).
 *  - Anybody else who is signed in (a client) only learns that uploads are down, never why ({ audience: "client", uploadsDown }).
 *  - Signed-out visitors get 401. When the feed cannot be read the answer is { unknown: true }: never a made-up all-clear.
 * Docs: docs/systems/supabase-status.md
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isMarketingUser, isStaffUser } from '@/lib/auth'
import { fetchSupabaseFeed, supabaseRegion } from '@/lib/infra/supabase-status-server'
import { openRelevantIncidents } from '@/lib/infra/supabase-status'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function handleSupabaseStatusGet(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  const feed = await fetchSupabaseFeed()
  if (!feed) return NextResponse.json({ unknown: true }, { headers: NO_STORE })
  const open = openRelevantIncidents(feed, supabaseRegion())
  if (isStaffUser(user) || isMarketingUser(user)) {
    return NextResponse.json({ audience: 'staff', incident: open[0] ?? null, others: Math.max(0, open.length - 1) }, { headers: NO_STORE })
  }
  return NextResponse.json({ audience: 'client', uploadsDown: open.some(i => i.affectsUploads) }, { headers: NO_STORE })
}
