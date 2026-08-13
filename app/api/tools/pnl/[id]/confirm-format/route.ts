/**
 * POST /api/tools/pnl/[id]/confirm-format — staff resolves a QUARANTINED
 * statement format (S1, 2026-07-07; STAFF ONLY).
 *
 * Body: { mapping_id, action: 'confirm' | 'reject', path }
 *  - confirm → mapping status 'staff_confirmed' (audit: who/when) and the
 *    file's ingest job is RE-ENQUEUED — it now parses deterministically
 *    through the confirmed mapping. Every future file with this header
 *    fingerprint (any client) parses with zero AI and zero taps.
 *  - reject → mapping status 'rejected'; the file stays failed (staff deletes
 *    it and requests a proper export). Rejected fingerprints skip proposal
 *    and fall to AI row-extraction on later uploads.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    const body = await request.json().catch(() => ({})) as { mapping_id?: string; action?: string; path?: string }
    if (!body.mapping_id || (body.action !== 'confirm' && body.action !== 'reject')) {
      return NextResponse.json({ error: "mapping_id and action ('confirm'|'reject') are required." }, { status: 400 })
    }
    // When a workspace file is being re-run, its path must belong to THIS
    // workspace (no cross-workspace re-enqueues). A confirm WITHOUT a path is
    // legal (card 4a39e0fd round 2): the quarantine may belong to a PORTAL
    // upload — the portal requeue below finds those by mapping id.
    if (body.action === 'confirm' && body.path && !body.path.startsWith(`pnl-workspaces/${workspaceId}/`)) {
      return NextResponse.json({ error: 'path must be a statement of this workspace.' }, { status: 400 })
    }

    const { data: mapping } = await db
      .from('statement_format_mappings')
      .select('id, status, bank_label, fingerprint')
      .eq('id', body.mapping_id)
      .maybeSingle()
    if (!mapping) return NextResponse.json({ error: 'Format proposal not found.' }, { status: 404 })
    if (mapping.status !== 'proposed') {
      return NextResponse.json({ error: `This proposal was already ${mapping.status.replace('_', ' ')}.` }, { status: 409 })
    }

    const nextStatus = body.action === 'confirm' ? 'staff_confirmed' : 'rejected'
    const { error: updErr } = await db
      .from('statement_format_mappings')
      .update({ status: nextStatus, created_by: user?.email ?? 'staff', updated_at: new Date().toISOString() })
      .eq('id', body.mapping_id)
      .eq('status', 'proposed') // TOCTOU: two staff clicking resolve once
    if (updErr) throw new Error(updErr.message)

    try {
      await db.from('action_log').insert({
        actor: user?.email ?? 'staff',
        action_type: 'statement_format_' + nextStatus,
        table_name: 'statement_format_mappings',
        record_id: body.mapping_id,
        summary: `${body.action === 'confirm' ? 'Confirmed' : 'Rejected'} statement format "${mapping.bank_label}" (${String(mapping.fingerprint).slice(0, 80)}…)`,
        details: { workspace_id: workspaceId, mapping_id: body.mapping_id, path: body.path ?? null },
      })
    } catch (e) {
      console.error('[tools/pnl] format-confirm audit failed (decision saved):', e)
    }

    // Card 4a39e0fd: a confirmed format also re-processes every QUARANTINED
    // CLIENT file waiting on this mapping (portal pipeline) — a client must
    // never sit stuck behind a format staff already approved. Best-effort:
    // a failure here never voids the confirm (the mapping is saved; the
    // 5-min cron + a re-upload still recover the file).
    let portalRequeue = { requeued: 0, cancelled: 0, skipped: 0 }
    if (body.action === 'confirm') {
      try {
        const { requeueQuarantinedPortalIngests } = await import('@/lib/tax/quarantine-requeue')
        portalRequeue = await requeueQuarantinedPortalIngests(body.mapping_id)
      } catch (e) {
        console.error('[tools/pnl] portal quarantine requeue failed (confirm saved):', e)
      }
    }

    let requeued = false
    if (body.action === 'confirm' && body.path) {
      const { data: live } = await db
        .from('job_queue')
        .select('id')
        .eq('job_type', 'ingest_workspace_statement')
        .eq('related_entity_id', workspaceId)
        .in('status', ['pending', 'processing'])
        .eq('payload->>path', body.path)
        .limit(1)
      if (!live || live.length === 0) {
        const { error } = await db.from('job_queue').insert({
          job_type: 'ingest_workspace_statement',
          payload: { workspace_id: workspaceId, path: body.path },
          related_entity_type: 'pnl_workspace',
          related_entity_id: workspaceId,
          created_by: 'format_confirm',
        })
        if (error) throw new Error(error.message)
      }
      requeued = true
    }

    return NextResponse.json({ ok: true, status: nextStatus, requeued, portal_requeue: portalRequeue })
  } catch (err) {
    console.error('[tools/pnl] confirm-format failed:', err)
    return NextResponse.json({ error: 'Could not save the format decision — please try again.' }, { status: 500 })
  }
}
