import { NextResponse } from 'next/server'
import { discardDraft, getVersion, saveDraft } from '@/lib/contracts/service-contract-texts'
import { validateContractWording } from '@/lib/contracts/contract-wording'
import { toVersionView } from '@/lib/contracts/service-contract-view'
import { errorResponse, requireStaff } from '../../_gate'

export const dynamic = 'force-dynamic'

/**
 * PUT /api/service-contracts/versions/[id]  { content, expectedHash }
 * Save an edit of an OPEN draft. The wording is checked first; problems come back keyed by the line they belong to
 * so the screen can show each one next to its line. `expectedHash` makes the save refuse if the draft changed meanwhile.
 */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireStaff()
  if ('res' in gate) return gate.res
  const body = (await req.json().catch(() => ({}))) as { content?: unknown; expectedHash?: string }
  const check = validateContractWording(body.content)
  if ('errors' in check) {
    return NextResponse.json({ error: 'The wording is not valid: ' + check.errors.join('; '), code: 'INVALID_WORDING', details: check.errors, fields: check.fields }, { status: 422 })
  }
  try {
    const row = await saveDraft({ id: params.id, content: check.wording, source: 'manual', expectedHash: typeof body.expectedHash === 'string' ? body.expectedHash : undefined })
    return NextResponse.json({ version: toVersionView(row) })
  } catch (e) {
    return errorResponse(e)
  }
}

/** DELETE /api/service-contracts/versions/[id] — throw away an open draft (an approved version can never be deleted). */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireStaff()
  if ('res' in gate) return gate.res
  try {
    const row = await getVersion(params.id)
    if (!row) return NextResponse.json({ ok: true })
    if (row.status !== 'draft') return NextResponse.json({ error: 'Only a draft can be thrown away.', code: 'NOT_A_DRAFT' }, { status: 409 })
    const removed = await discardDraft(params.id)
    if (!removed) {
      // an owner approved it in the same moment: it is NOT thrown away
      const now = await getVersion(params.id)
      if (now) return NextResponse.json({ error: 'This draft was approved just now, so it was not thrown away.', code: 'NOT_A_DRAFT' }, { status: 409 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return errorResponse(e)
  }
}
