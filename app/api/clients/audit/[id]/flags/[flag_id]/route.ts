import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * DELETE /api/clients/audit/[id]/flags/[flag_id]
 *
 * Reverse (soft-delete) an audit flag. Sets reversed_by and reversed_at.
 * The row is NOT deleted — history is preserved for the action_log trail.
 *
 * Body:
 *   reversed_by   reviewer name (e.g. 'Antonio')
 *
 * Security: verifies the flag belongs to this account before reversing.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; flag_id: string } }
) {
  const accountId = params.id
  const flagId = params.flag_id

  let body: { reversed_by?: string } = {}
  try {
    body = await req.json()
  } catch {
    // reversed_by is optional in the body; we'll fall back to 'unknown'
  }
  const reversedBy = body.reversed_by ?? 'unknown'

  // ── Fetch the flag to verify it belongs to this account ────────────────
  const { data: existing, error: fetchErr } = await (supabaseAdmin as any)
    .from('audit_flags')
    .select('id, entity_type, entity_id, field_name, flag_type, reversed_at')
    .eq('id', flagId)
    .single()

  if (fetchErr || !existing) {
    return NextResponse.json({ error: 'Flag not found' }, { status: 404 })
  }

  if (existing.reversed_at) {
    return NextResponse.json({ error: 'Flag is already reversed' }, { status: 409 })
  }

  // Security: verify entity belongs to this account
  if (existing.entity_type === 'contact') {
    const { data: link } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', accountId)
      .eq('contact_id', existing.entity_id)
      .maybeSingle()
    if (!link) {
      return NextResponse.json({ error: 'Flag does not belong to this account' }, { status: 403 })
    }
  } else if (existing.entity_type === 'account') {
    if (existing.entity_id !== accountId) {
      return NextResponse.json({ error: 'Flag does not belong to this account' }, { status: 403 })
    }
  }

  // ── Soft-delete: set reversed_by + reversed_at ──────────────────────────
  const { error: updateErr } = await (supabaseAdmin as any)
    .from('audit_flags')
    .update({
      reversed_by: reversedBy,
      reversed_at: new Date().toISOString(),
    })
    .eq('id', flagId)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  // ── action_log ──────────────────────────────────────────────────────────
  void supabaseAdmin.from('action_log').insert({
    account_id: accountId,
    action_type: 'audit_flag_reversed',
    table_name: 'audit_flags',
    summary: `${reversedBy} reversed ${existing.flag_type} flag on ${existing.entity_type} ${existing.entity_id} field "${existing.field_name}"`,
  }) // non-blocking

  return NextResponse.json({ ok: true })
}
