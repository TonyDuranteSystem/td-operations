import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isFieldEligibleForNA } from '@/lib/audit/na-allow-list'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/clients/audit/[id]/flags
 *
 * Set an audit flag (N/A or follow_up) on a specific field for an entity
 * (account or contact) associated with this account.
 *
 * Body:
 *   entity_type  'account' | 'contact'
 *   entity_id    UUID of the entity being flagged
 *   field_name   DB column name (e.g. 'citizenship', 'ein_number')
 *   flag_type    'na' | 'follow_up'
 *   note         string (required for 'na', optional for 'follow_up')
 *   marked_by    reviewer name (e.g. 'Antonio')
 *
 * Validation:
 *   - note required for 'na'
 *   - critical fields (email, full_name, entity_type, state_of_formation) blocked
 *   - N/A allow-list checked against active service_deliveries
 *
 * DB operation:
 *   Upsert on (entity_type, entity_id, field_name, flag_type) — clears reversed_at/reversed_by
 *   if re-flagging after a reversal.
 *
 * action_log:
 *   Writes audit_flag_set event for the audit trail.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const accountId = params.id

  let body: {
    entity_type?: string
    entity_id?: string
    field_name?: string
    flag_type?: string
    note?: string
    marked_by?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { entity_type, entity_id, field_name, flag_type, note, marked_by } = body

  // ── Input validation ────────────────────────────────────────────────────
  if (!entity_type || !['account', 'contact'].includes(entity_type)) {
    return NextResponse.json({ error: 'entity_type must be "account" or "contact"' }, { status: 400 })
  }
  if (!entity_id) {
    return NextResponse.json({ error: 'entity_id is required' }, { status: 400 })
  }
  if (!field_name) {
    return NextResponse.json({ error: 'field_name is required' }, { status: 400 })
  }
  if (!flag_type || !['na', 'follow_up'].includes(flag_type)) {
    return NextResponse.json({ error: 'flag_type must be "na" or "follow_up"' }, { status: 400 })
  }
  if (flag_type === 'na' && (!note || note.trim() === '')) {
    return NextResponse.json({ error: 'note is required when flag_type is "na"' }, { status: 400 })
  }
  if (!marked_by) {
    return NextResponse.json({ error: 'marked_by is required' }, { status: 400 })
  }

  // ── Critical field check (N/A only) ────────────────────────────────────
  if (flag_type === 'na') {
    const contactCritical = new Set(['email', 'full_name'])
    const accountCritical = new Set(['entity_type', 'state_of_formation'])
    const isCritical =
      (entity_type === 'contact' && contactCritical.has(field_name)) ||
      (entity_type === 'account' && accountCritical.has(field_name))
    if (isCritical) {
      return NextResponse.json(
        { error: `${field_name} is a critical field and cannot be marked N/A` },
        { status: 422 }
      )
    }

    // ── N/A allow-list check ──────────────────────────────────────────────
    // Fetch active service_deliveries for this account to check service context
    const { data: sds } = await supabaseAdmin
      .from('service_deliveries')
      .select('service_type')
      .eq('account_id', accountId)
      .not('status', 'eq', 'Cancelled')

    const activeServices = (sds ?? []).map((sd: { service_type: string }) => sd.service_type)
    const eligible = isFieldEligibleForNA(field_name, entity_type as 'account' | 'contact', activeServices)
    if (!eligible) {
      return NextResponse.json(
        { error: `${field_name} is not eligible for N/A given the active service context` },
        { status: 422 }
      )
    }
  }

  // ── Verify entity_id belongs to this account (security check) ──────────
  if (entity_type === 'contact') {
    const { data: link } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', accountId)
      .eq('contact_id', entity_id)
      .maybeSingle()
    if (!link) {
      return NextResponse.json(
        { error: 'contact is not linked to this account' },
        { status: 403 }
      )
    }
  } else if (entity_type === 'account') {
    if (entity_id !== accountId) {
      return NextResponse.json(
        { error: 'entity_id does not match account' },
        { status: 403 }
      )
    }
  }

  // ── Upsert flag ─────────────────────────────────────────────────────────
  // ON CONFLICT: update marked_by, marked_at, note; clear reversed_by/reversed_at
  const { data: flagRow, error: upsertErr } = await (supabaseAdmin as any)
    .from('audit_flags')
    .upsert({
      entity_type,
      entity_id,
      field_name,
      flag_type,
      note: note?.trim() ?? null,
      marked_by,
      marked_at: new Date().toISOString(),
      reversed_by: null,
      reversed_at: null,
    }, {
      onConflict: 'entity_type,entity_id,field_name,flag_type',
    })
    .select('id')
    .single()

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 })
  }

  // ── action_log ──────────────────────────────────────────────────────────
  void supabaseAdmin.from('action_log').insert({
    account_id: accountId,
    action_type: 'audit_flag_set',
    table_name: 'audit_flags',
    summary: `${marked_by} marked ${entity_type} ${entity_id} field "${field_name}" as ${flag_type}${note ? ` — "${note.trim()}"` : ''}`,
  }) // non-blocking

  return NextResponse.json({ ok: true, flag_id: flagRow?.id })
}
