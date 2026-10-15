/**
 * The facts the Company Closure "Wrap-up" panel shows. Backs the `closure_wrapup` stage_layout component. READ-ONLY.
 *
 * GET → { success, facts }   (lib/closure/wrapup-facts.ts WrapUpFacts; every section carries its own ok / error so one
 *                             failed read never reads as "nothing found")
 *
 * [id] = service_delivery_id of a Company Closure job. Staff-only: /api/* is not covered by the middleware's client bounce,
 * so the route checks for itself (lib/auth/require-staff-route.ts).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { loadWrapUpFacts } from '@/lib/closure/wrapup-facts-load'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const result = await loadWrapUpFacts(params.id)
    if (result.ok === false) return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    return NextResponse.json({ success: true, facts: result.facts })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error && e.message ? e.message : 'Could not read the Wrap-up facts.' }, { status: 500 })
  }
}
