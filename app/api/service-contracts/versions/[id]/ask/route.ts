import { NextResponse } from 'next/server'
import { getVersion, saveDraft } from '@/lib/contracts/service-contract-texts'
import { validateContractWording } from '@/lib/contracts/contract-wording'
import { toVersionView, loadServiceFacts } from '@/lib/contracts/service-contract-view'
import { reviseWording } from '@/lib/contracts/draft-with-claude'
import { errorResponse, requireStaff } from '../../../_gate'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

/** POST /api/service-contracts/versions/[id]/ask  { request } — Claude changes the open draft as asked, in plain words. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireStaff()
  if ('res' in gate) return gate.res
  const body = (await req.json().catch(() => ({}))) as { request?: string }
  const request = String(body.request ?? '').trim()
  if (!request) return NextResponse.json({ error: 'Write what you want changed.' }, { status: 400 })
  try {
    const row = await getVersion(params.id)
    if (!row) return NextResponse.json({ error: 'That contract version no longer exists.', code: 'NOT_FOUND' }, { status: 404 })
    if (row.status !== 'draft') return NextResponse.json({ error: 'Only a draft can be changed. Start a new version first.', code: 'NOT_A_DRAFT' }, { status: 409 })
    const current = validateContractWording(row.content)
    if ('errors' in current) return NextResponse.json({ error: 'The stored draft is not valid wording: ' + current.errors.join('; '), code: 'INVALID_WORDING' }, { status: 422 })
    const facts = await loadServiceFacts(row.service_entry_id)
    const changed = await reviseWording(current.wording, request, facts)
    if ('error' in changed) return NextResponse.json({ error: changed.error, ...(changed.details ? { details: changed.details } : {}) }, { status: 502 })
    const saved = await saveDraft({ id: row.id, content: changed.wording, source: 'claude_change', note: request.slice(0, 500), expectedHash: row.content_hash })
    return NextResponse.json({ version: toVersionView(saved) })
  } catch (e) {
    return errorResponse(e)
  }
}
