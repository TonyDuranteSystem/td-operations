import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'

/**
 * GET /api/portal/announcements
 * Returns active portal announcements for display in the client portal.
 * No auth required — announcements are public (they contain no private data).
 * Graceful fallback if the table doesn't exist yet (first deploy before migration).
 */
export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from('portal_announcements')
      .select('id, title, message, type, dismissible')
      .eq('active', true)
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
