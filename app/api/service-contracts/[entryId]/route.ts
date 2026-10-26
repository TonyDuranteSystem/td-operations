import { NextResponse } from 'next/server'
import { isOwnerOnly } from '@/lib/auth'
import { loadContractView, staffNameFromEmail } from '@/lib/contracts/service-contract-view'
import { errorResponse, requireStaff } from '../_gate'

export const dynamic = 'force-dynamic'

/** GET /api/service-contracts/[entryId] — where this service's contract stands, with every version. */
export async function GET(_req: Request, { params }: { params: { entryId: string } }) {
  const gate = await requireStaff()
  if ('res' in gate) return gate.res
  try {
    const view = await loadContractView(params.entryId)
    return NextResponse.json({
      ...view,
      viewer: { canApprove: isOwnerOnly(gate.user), name: staffNameFromEmail(gate.user.email) },
      aiConfigured: !!process.env.ANTHROPIC_API_KEY,
    })
  } catch (e) {
    return errorResponse(e)
  }
}
