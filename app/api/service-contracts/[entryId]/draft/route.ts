import { NextResponse } from 'next/server'
import { createDraft, getApproved, getOpenDraft } from '@/lib/contracts/service-contract-texts'
import { toVersionView, loadServiceFacts, contractEligibility } from '@/lib/contracts/service-contract-view'
import { draftWording } from '@/lib/contracts/draft-with-claude'
import { getEntryById } from '@/lib/catalog/framework'
import { actorOf, errorResponse, requireStaff, whoOf } from '../../_gate'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

/**
 * POST /api/service-contracts/[entryId]/draft
 *   { mode: "claude" }        — Claude writes the first draft from the service's name, description and steps
 *   { mode: "from_approved" } — a new version that starts as a copy of the approved wording (then edited / changed)
 * Either way the result is a DRAFT: nothing reaches a client until an owner approves it.
 */
export async function POST(req: Request, { params }: { params: { entryId: string } }) {
  const gate = await requireStaff()
  if ('res' in gate) return gate.res
  const body = (await req.json().catch(() => ({}))) as { mode?: string }
  try {
    const entry = await getEntryById(params.entryId)
    if (!entry || entry.catalog_id !== 'services') return NextResponse.json({ error: 'That service does not exist.', code: 'NOT_FOUND' }, { status: 404 })
    const meta = (entry.metadata ?? {}) as Record<string, unknown>
    const eligible = contractEligibility(typeof meta.contract_type === 'string' ? meta.contract_type : null, typeof meta.pipeline === 'string' ? meta.pipeline : null)
    if (eligible.kind !== 'new') {
      return NextResponse.json({ error: eligible.note ?? 'A contract cannot be written here for this service.', code: 'BUILT_IN_CONTRACT' }, { status: 409 })
    }
    if (await getOpenDraft(params.entryId)) {
      return NextResponse.json({ error: 'This service already has an open draft — open that one.', code: 'DRAFT_EXISTS' }, { status: 409 })
    }

    if (body.mode === 'from_approved') {
      const approved = await getApproved(params.entryId)
      if (!approved) return NextResponse.json({ error: 'There is no approved contract to start a new version from.', code: 'NOT_FOUND' }, { status: 404 })
      const row = await createDraft({
        entryId: params.entryId,
        content: approved.content,
        source: 'manual',
        createdBy: whoOf(gate.user),
        note: `Started from version ${approved.version}`,
        actor: actorOf(gate.user),
      })
      return NextResponse.json({ version: toVersionView(row) })
    }

    if (body.mode !== 'claude') return NextResponse.json({ error: 'Unknown mode.' }, { status: 400 })
    const facts = await loadServiceFacts(params.entryId)
    const drafted = await draftWording(facts)
    if ('error' in drafted) return NextResponse.json({ error: drafted.error, ...(drafted.details ? { details: drafted.details } : {}) }, { status: 502 })
    const row = await createDraft({
      entryId: params.entryId,
      content: drafted.wording,
      source: 'claude_draft',
      createdBy: whoOf(gate.user),
      note: null,
      actor: actorOf(gate.user),
    })
    return NextResponse.json({ version: toVersionView(row) })
  } catch (e) {
    return errorResponse(e)
  }
}
