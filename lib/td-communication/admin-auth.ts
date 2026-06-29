/**
 * TD Communication — admin API auth gates.
 *
 * IMPORTANT: reads use ensureStaff (NOT isDashboardUser). isDashboardUser is
 * `!isClient`, which returns TRUE for a `role='partner'` user (e.g. Cris), and
 * middleware allows partners on /api/td-communication*. ensureStaff resolves the
 * caller via resolveCommParticipant and requires type==='staff', so a partner is
 * excluded from the admin tabs (which would otherwise leak every client's brief).
 *
 * Writes use ensureAdmin — a partner is never admin, so this is also partner-safe.
 */

import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { isAdmin } from '@/lib/auth'
import { resolveCommParticipant } from './queries'

/** Staff-only gate. Returns an error response to return, or null if the caller is staff. */
export async function ensureStaff(user: User | null): Promise<NextResponse | null> {
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const participant = await resolveCommParticipant(user)
  if (!participant || participant.type !== 'staff') {
    return NextResponse.json({ error: 'Staff access required' }, { status: 403 })
  }
  return null
}

/** Admin-only gate for writes. Returns an error response to return, or null if admin. */
export function ensureAdmin(user: User | null): NextResponse | null {
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdmin(user)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  return null
}
