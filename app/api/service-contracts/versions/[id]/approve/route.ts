import { NextResponse } from 'next/server'
import { approveDraft, getVersion } from '@/lib/contracts/service-contract-texts'
import { validateContractWording } from '@/lib/contracts/contract-wording'
import { toVersionView } from '@/lib/contracts/service-contract-view'
import { errorResponse, requireOwner, whoOf } from '../../../_gate'

export const dynamic = 'force-dynamic'

/**
 * POST /api/service-contracts/versions/[id]/approve  { expectedHash }
 * OWNER ONLY. Approves exactly the wording whose fingerprint the owner read: if the draft changed since, the database
 * refuses (DRAFT_CHANGED) and nothing is approved. The previously approved version becomes "replaced" in the same step.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireOwner()
  if ('res' in gate) return gate.res
  const body = (await req.json().catch(() => ({}))) as { expectedHash?: string }
  if (!body.expectedHash || typeof body.expectedHash !== 'string') {
    return NextResponse.json({ error: 'Missing the fingerprint of the wording that was read.' }, { status: 400 })
  }
  try {
    // Never approve wording the client's page could not show: check it here, where the database cannot.
    const current = await getVersion(params.id)
    if (!current) return NextResponse.json({ error: 'That contract version no longer exists.', code: 'NOT_FOUND' }, { status: 404 })
    const check = validateContractWording(current.content)
    if ('errors' in check) {
      return NextResponse.json({ error: 'This draft cannot be approved because its wording is not valid: ' + check.errors.join('; '), code: 'INVALID_WORDING', details: check.errors }, { status: 422 })
    }
    const row = await approveDraft({ id: params.id, expectedHash: body.expectedHash, approvedBy: whoOf(gate.user) })
    return NextResponse.json({ version: toVersionView(row) })
  } catch (e) {
    return errorResponse(e)
  }
}
