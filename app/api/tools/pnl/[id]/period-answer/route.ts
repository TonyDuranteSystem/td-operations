/**
 * POST /api/tools/pnl/[id]/period-answer — apply one location-period answer
 * ("Were you in Italy Feb–Aug?" → all business / all personal) as a REVERSIBLE
 * attested batch (STAFF ONLY, Phase 2b).
 *
 * S4 (2026-07-06): the sweep body moved VERBATIM to
 * `lib/tax/country-policy-sweep.ts::applyLocationAnswer` — one shared core for
 * this interactive route and the automatic country_policy_sweep job. All five
 * senior-engineer guard conditions live in the core now:
 *  (i)   period descriptor + displayed counts in, eligible set recomputed
 *        server-side fresh — never transaction ids;
 *  (ii)  the UPDATE re-evaluates the full predicate itself (two atomic UPDATEs
 *        unioning to the NULL-safe manual guard — the PostgREST PATCH-or() bug);
 *  (iii) 409 when the recomputed count/total differs from what the modal
 *        showed (`expected` — interactive path only; the auto path passes null);
 *  (iv)  409 while the workspace is stale — recomputed, never trusted;
 *  (v)   server-generated batch id; duplicate submit finds an empty eligible
 *        set and 409s — no orphan headers.
 *
 * Period answers write ZERO learned rules and ZERO catalog entries — "Glovo =
 * business" was true for the Italy period only; merchant-level learning stays
 * exclusively on per-group answers.
 */

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { applyLocationAnswer } from '@/lib/tax/country-policy-sweep'

export const dynamic = 'force-dynamic'

const LOC_CODE_RE = /^[A-Z]{2}$/

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    const body = await request.json().catch(() => ({})) as {
      loc_codes?: string[]; period_start?: string; period_end?: string
      choice?: string; expected_row_count?: number; expected_dollar_total?: number
      scope?: string
    }
    const locCodes = Array.isArray(body.loc_codes) ? body.loc_codes.filter(c => typeof c === 'string' && LOC_CODE_RE.test(c)) : []
    const { choice } = body
    // S3: scope 'country' = a COUNTRY-POLICY answer ("everything in Spain is
    // business") — full tax year, derived server-side in the core. The stored
    // full-year answer row IS the policy record the S4 sweep replays.
    const scope: 'period' | 'country' = body.scope === 'country' ? 'country' : 'period'
    if (locCodes.length === 0 || (choice !== 'business' && choice !== 'personal')
      || typeof body.expected_row_count !== 'number' || typeof body.expected_dollar_total !== 'number') {
      return NextResponse.json({ error: 'loc_codes, choice (business|personal), expected_row_count and expected_dollar_total are required.' }, { status: 400 })
    }
    if (scope === 'period' && (!body.period_start || !body.period_end)) {
      return NextResponse.json({ error: 'period_start and period_end are required.' }, { status: 400 })
    }

    // Hard-stop parity (2026-08-21, live-QA bug-hunter blocker): this route
    // had NO structural-problem check — reachable from the "Time away from
    // home base" section, which was not gated. A blocked workspace could
    // have real categorization decisions swept while the P&L/BS themselves
    // were correctly hidden. Same check the client-portal twin now has.
    const { getWorkspaceStructuralProblem } = await import('@/lib/tax/workspace-orchestration')
    if (await getWorkspaceStructuralProblem(workspaceId)) {
      return NextResponse.json({ error: 'This workspace has an unresolved data problem (an unreadable statement, or a missing-months question) — fix that first before answering anything else.' }, { status: 422 })
    }

    const result = await applyLocationAnswer({
      workspaceId,
      locCodes,
      choice,
      scope,
      periodStart: body.period_start,
      periodEnd: body.period_end,
      actorId: user?.email ?? 'staff',
      actorRole: 'staff', // v1 is staff-only; 'client' is reserved for the portal flip
      expected: { rowCount: body.expected_row_count, dollarTotal: body.expected_dollar_total },
    })

    switch (result.status) {
      case 'not_found':
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
      case 'no_tax_year':
        return NextResponse.json({ error: 'Workspace has no tax year.' }, { status: 400 })
      case 'stale':
        return NextResponse.json({ error: 'New statements were added after the last generation — Regenerate the P&L first.' }, { status: 409 })
      case 'count_mismatch':
        return NextResponse.json({
          error: 'The transactions in this period changed since the screen loaded — review the updated numbers and confirm again.',
          fresh: result.fresh,
        }, { status: 409 })
      case 'nothing_left':
        return NextResponse.json({ error: 'Nothing left to book in this period (it may already be answered).' }, { status: 409 })
      case 'ok':
        return NextResponse.json({
          ok: true,
          batch_id: result.batchId,
          swept: result.swept,
          skipped_manual: result.skippedManual,
          skipped_ineligible: result.skippedIneligible,
        })
    }
  } catch (err) {
    console.error('[tools/pnl] period-answer failed:', err)
    return NextResponse.json({ error: 'Could not book the period — please try again.' }, { status: 500 })
  }
}
