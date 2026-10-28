/**
 * GET /api/crm/admin-actions/workspace-types — "which document types does ANY workspace upload box take?" (dev job e3215801). Read-only, staff only.
 * -> { summary: { types: string[], vagueTypes: string[] } }, built from the workspace's own stage layouts (lib/flows/storage-step-rules.ts).
 * The Storage page and the contact page load it once so an ordinary file (a passport, a bank statement …) is not even sent to the
 * "is a workspace step waiting?" check. If it cannot be loaded the pages check EVERY upload instead — the check itself fails closed.
 */
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

export async function GET() {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const { loadStepHints, waitSummary } = await import('@/lib/flows/storage-step-hints')
    return NextResponse.json({ summary: waitSummary(await loadStepHints()) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Could not read the workspace upload steps.' }, { status: 503 })
  }
}
