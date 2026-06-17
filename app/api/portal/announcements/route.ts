import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'

// This route hits the DB on every request and must never be statically
// prerendered. Without this, Next's build-time static export invokes the
// handler with placeholder Supabase env (as CI does) and intermittently fails
// with "No response is returned from route handler", breaking CI builds.
export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/announcements
 * Returns active portal announcements for display in the client portal.
 * No auth required — announcements are public (they contain no private data).
 * Graceful fallback if the table doesn't exist yet (first deploy before migration).
 */
export async function GET() {
  try {
    const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from('portal_announcements')
      .select('id, title, message, title_en, message_en, type, dismissible')
      .eq('active', true)
      .or(`active_from.is.null,active_from.lte.${today}`)
      .or(`active_until.is.null,active_until.gte.${today}`)
      .order('created_at', { ascending: false })

    if (error) {
      // Table doesn't exist yet in this environment — return empty list
      if (error.code === 'PGRST200' || error.message?.includes('portal_announcements')) {
        return NextResponse.json({ announcements: [] })
      }
      return NextResponse.json({ announcements: [] })
    }

    return NextResponse.json({ announcements: data ?? [] })
  } catch {
    return NextResponse.json({ announcements: [] })
  }
}
