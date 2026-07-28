/**
 * GET /api/flows/[id]/materialize-preflight
 *
 * Read-only dry-run of the deterministic company-materialization gates for a
 * Company Formation flow: is there formation data, a confirmed filed name, and
 * a resolvable LLC type? The workspace Articles-upload modal calls this when
 * it opens so it can require the staff LLC-type field UP FRONT instead of
 * letting the advance fail after the upload (Covelli/DoctorGut, 2026-07-28).
 * advanceServiceDelivery runs the same check server-side as the enforcement
 * gate — this route only exists so the UI can ask ahead. Staff-only
 * (middleware). Mutates nothing.
 *
 * Response: { applicable: false } for non-formation / already-materialized
 * flows, else { applicable: true, ok, failure?, error?, entity_code?,
 * entity_source?, chosen_name? }.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { preflightFormationMaterialization } from '@/lib/operations/formation-materialize'
import { filedName, type NameCheck } from '@/lib/flows/name-checks'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- name_checks not in generated types
    const { data: sd } = await (supabaseAdmin as any)
      .from('service_deliveries')
      .select('id, service_type, account_id, contact_id, name_checks')
      .eq('id', params.id)
      .maybeSingle()

    if (!sd) {
      return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    }
    if (sd.service_type !== 'Company Formation' || sd.account_id || !sd.contact_id) {
      return NextResponse.json({ success: true, applicable: false })
    }

    const confirmedName = filedName((sd.name_checks as NameCheck[] | null) ?? null)
    const pre = await preflightFormationMaterialization({
      contact_id: sd.contact_id,
      chosen_name: confirmedName,
    })

    return NextResponse.json({
      success: true,
      applicable: true,
      ok: pre.ok,
      failure: pre.failure ?? null,
      error: pre.error ?? null,
      chosen_name: pre.chosen_name ?? confirmedName ?? null,
      entity_code: pre.entity_code ?? null,
      entity_source: pre.entity_source ?? null,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
