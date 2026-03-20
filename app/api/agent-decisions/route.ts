import { supabaseAdmin } from '@/lib/supabase-admin'
import { createDecision, approveDecision, rejectDecision } from '@/lib/agent-decisions'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/agent-decisions?status=pending|approved|rejected
 * List agent decisions filtered by status.
 * Default: pending (approved IS NULL).
 * Protected by auth middleware (dashboard routes require session).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? 'pending'
  const limit = Math.min(Number(searchParams.get('limit') ?? '20'), 50)

  let query = supabaseAdmin
    .from('agent_decisions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status === 'pending') {
    query = query.is('approved', null)
  } else if (status === 'approved') {
    query = query.eq('approved', true)
  } else if (status === 'rejected') {
    query = query.eq('approved', false)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ decisions: data ?? [] })
}

/**
 * POST /api/agent-decisions
 * Create a new pending decision.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { situation, action_taken, tools_used, account_id, contact_id, task_id } = body

    if (!situation || !action_taken) {
      return NextResponse.json(
        { error: 'situation and action_taken are required' },
        { status: 400 }
      )
    }

    const decision = await createDecision({
      situation,
      action_taken,
      tools_used,
      account_id,
      contact_id,
      task_id,
    })

    return NextResponse.json({ decision }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * PATCH /api/agent-decisions
 * Approve or reject a decision.
 * Body: { id: string, approved: boolean }
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, approved } = body

    if (!id || typeof approved !== 'boolean') {
      return NextResponse.json(
        { error: 'id (string) and approved (boolean) are required' },
        { status: 400 }
      )
    }

    const decision = approved
      ? await approveDecision(id)
      : await rejectDecision(id)

    return NextResponse.json({ decision })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
