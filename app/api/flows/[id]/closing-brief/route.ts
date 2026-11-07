/**
 * GET /api/flows/[id]/closing-brief — what finishing a Company Closure job will do, for the ask-first question.
 *
 * Names the company the job is linked to and lists what goes with it (other services, unpaid invoices, deadlines, to-dos, people with
 * portal access, a lease), plus the wizard's "the client wrote a different company" check line when there is one. Read-only; the
 * question is shown by components/flows/action-buttons.tsx before the finish button acts.
 *
 * [id] = service_delivery_id. Staff only.
 * Company Closure Part C, dev job a6bbea09.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { readClosingBrief } from '@/lib/operations/close-company'
import { closingBriefLines, closingHeadline, closingWarning } from '@/lib/closure/closing-brief'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const brief = await readClosingBrief(params.id)
    if (!brief) return NextResponse.json({ success: true, brief: null })
    return NextResponse.json({
      success: true,
      brief,
      headline: closingHeadline(brief),
      lines: closingBriefLines(brief),
      warning: closingWarning(brief),
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
