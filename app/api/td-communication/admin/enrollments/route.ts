import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureStaff } from '@/lib/td-communication/admin-auth'
import { listEnrollments } from '@/lib/td-communication/pipeline-queries'
import { computeEnrollmentStats, filterByStatus } from '@/lib/td-communication/enrollment-stats'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/admin/enrollments?status=<status> — enrollments list
 * + aggregate stats for the admin Enrollments tab. Stats are computed over ALL
 * enrollments; the list is filtered by the optional status. Staff only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await ensureStaff(user)
  if (gate) return gate

  try {
    const all = await listEnrollments()
    const status = req.nextUrl.searchParams.get('status')
    const enrollments = filterByStatus(all, status)
    const stats = computeEnrollmentStats(all, new Date())
    return NextResponse.json({ enrollments, stats })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load enrollments.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
