/**
 * POST /api/tools/pnl/[id]/save — save a workspace TO a real client (STAFF ONLY).
 *
 * The ONLY route in the tool that writes real client books. All safety lives in
 * `saveWorkspaceToClient` (concurrency guard, non-destructive merge/replace,
 * reversible Replace snapshot, action_log audit). This route just authenticates,
 * resolves the target + tax year, and delegates.
 *
 * Body: { target_account_id, tax_year?, mode?: 'merge' | 'replace' }
 * A non-empty target with no `mode` returns 409 so the UI can prompt Merge/Replace.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  const actor = user?.email ?? user?.id ?? 'staff'

  try {
    const body = await request.json().catch(() => ({})) as { target_account_id?: string; tax_year?: number; mode?: 'merge' | 'replace' }
    if (!body.target_account_id) return NextResponse.json({ error: 'target_account_id is required.' }, { status: 400 })

    const { data: ws } = await db
      .from('pnl_workspaces')
      .select('tax_year')
      .eq('id', params.id)
      .maybeSingle()
    if (!ws) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })
    const taxYear = Number.isInteger(body.tax_year) ? Number(body.tax_year) : Number(ws.tax_year)

    const { saveWorkspaceToClient } = await import('@/lib/tax/workspace-save')
    const result = await saveWorkspaceToClient({
      workspaceId: params.id,
      targetAccountId: body.target_account_id,
      taxYear,
      mode: body.mode,
      actor,
    })

    if (!result.ok) {
      // Refused (concurrency, or non-empty target needing a mode) — 409 so the UI prompts.
      // backupPath forwarded (2026-08-21, round-3 bug-hunter major finding):
      // on the rare Replace-then-reappeared-problem refusal, the client's
      // rows are already deleted and a restore point exists — staff need
      // that path immediately, not a separate action_log lookup.
      return NextResponse.json({ ok: false, action: result.action, error: result.reason, backupPath: result.backupPath }, { status: 409 })
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('[tools/pnl] save failed:', err)
    return NextResponse.json({ error: err instanceof Error && err.message ? err.message : 'Save failed — please try again.' }, { status: 500 })
  }
}
