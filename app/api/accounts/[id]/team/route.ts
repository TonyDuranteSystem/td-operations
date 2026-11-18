/**
 * The Team card on a company's page in the CRM (Team Powers step 5) — STAFF ONLY, read-only.
 *   GET /api/accounts/[id]/team   → { ready, members: [...] } the portal team logins of THIS company
 * Never touches the company's members list or any contact. The switch off / on is the sibling route.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { loadTeamCard } from '@/lib/portal/team/crm-server'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    return NextResponse.json(await loadTeamCard(params.id), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not load the team.' }, { status: 500 })
  }
}
