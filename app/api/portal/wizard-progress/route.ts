/**
 * POST /api/portal/wizard-progress — Save wizard progress (auto-save + manual save)
 * Creates or updates wizard_progress row. Used by portal wizard for save & resume.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { canSubmitWizard } from '@/lib/portal/wizard-submit-access'
import { accountIdForWizardSubmission } from '@/lib/portal/wizard-scope'
import { formationLeadOwned } from '@/lib/portal/formation-lead-access'
import { verifyClosureServiceDelivery } from '@/lib/portal/closure-subject'

/**
 * Re-prove that the logged-in identity owns a lead-scoped wizard_progress row
 * (account_id null, contact_id null, lead_id set — the formation case). Mirrors
 * the wizard-submit 0b check so a client can't overwrite another client's
 * in-flight formation by supplying its lead_id.
 */
async function ownsLeadScopedRow(
  identity: Awaited<ReturnType<typeof resolvePortalIdentity>>,
  user: { email?: string | null },
  leadId: string,
): Promise<boolean> {
  const ctcId = identity.kind === 'contact' ? identity.contactId : null
  const ownerEmails = new Set<string>()
  if (user.email) ownerEmails.add(user.email.toLowerCase())
  if (ctcId) {
    const { data: c } = await supabaseAdmin.from('contacts').select('email').eq('id', ctcId).maybeSingle()
    if (c?.email) ownerEmails.add(String(c.email).toLowerCase())
  }
  const { data: leadOffer } = await supabaseAdmin
    .from('offers')
    .select('client_email, contract_type, contact_id')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return formationLeadOwned(leadOffer, ctcId, ownerEmails)
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { wizard_type, current_step, data, account_id: rawAccountId, contact_id, lead_id, progress_id, service_delivery_id: rawServiceDeliveryId } = body

  if (!wizard_type) {
    return NextResponse.json({ error: 'wizard_type is required' }, { status: 400 })
  }

  // A formation never carries an account_id (lives on contact+lead until the
  // Articles materialize the account). Same backstop as wizard-submit.
  const account_id = accountIdForWizardSubmission(wizard_type, rawAccountId)

  const identity = await resolvePortalIdentity(user)

  try {
    if (progress_id) {
      // ─── OWNERSHIP CHECK BEFORE UPDATE (default-deny) ───
      // The route previously trusted a client-supplied progress_id and wrote
      // `.eq('id', progress_id)` with NO ownership check, so any client could
      // overwrite another client's in-flight wizard data by supplying a
      // different UUID (security audit 2026-06-13, H1 / IDOR). Re-fetch the row
      // and verify the caller owns its subject before writing.
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('wizard_progress')
        .select('id, account_id, contact_id, lead_id')
        .eq('id', progress_id)
        .maybeSingle()

      if (fetchErr) throw fetchErr
      if (!existing) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }

      const rowAccountId = (existing.account_id as string | null) ?? null
      const rowContactId = (existing.contact_id as string | null) ?? null
      const rowLeadId = (existing.lead_id as string | null) ?? null

      let allowed = false
      if (rowAccountId || rowContactId) {
        // Account- or contact-scoped row → standard subject check.
        allowed = canSubmitWizard(identity, rowAccountId, rowContactId, wizard_type)
      } else if (rowLeadId) {
        // Lead-scoped formation row → re-prove lead ownership.
        allowed = await ownsLeadScopedRow(identity, user, rowLeadId)
      }
      // No scope at all (orphan row) → deny.

      if (!allowed) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }

      const { error } = await supabaseAdmin
        .from('wizard_progress')
        .update({
          current_step: current_step ?? 0,
          data: data || {},
          updated_at: new Date().toISOString(),
        })
        .eq('id', progress_id)

      if (error) throw error
      return NextResponse.json({ id: progress_id, updated: true })
    } else {
      // ─── OWNERSHIP CHECK BEFORE CREATE (default-deny) ───
      // CREATE previously accepted client-supplied account_id/contact_id/lead_id
      // unverified. Gate the subject the same way wizard-submit does.
      if (!canSubmitWizard(identity, account_id, contact_id ?? null, wizard_type)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
      if (lead_id && wizard_type === 'formation') {
        if (!(await ownsLeadScopedRow(identity, user, lead_id))) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 })
        }
      }

      // Closure only (dev job fbbf4abe): re-verify the client-supplied record
      // server-side rather than trust it — it names WHICH closure this draft
      // belongs to, and a stale/tampered/cancelled one must never be honored.
      let closureServiceDeliveryId: string | null = null
      if (wizard_type === 'closure' && rawServiceDeliveryId && identity.kind === 'contact') {
        const verified = await verifyClosureServiceDelivery(String(rawServiceDeliveryId), identity.contactId)
        if (!verified) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 })
        }
        closureServiceDeliveryId = String(rawServiceDeliveryId)
      }

      const { data: created, error } = await supabaseAdmin
        .from('wizard_progress')
        .insert({
          wizard_type,
          current_step: current_step ?? 0,
          data: data || {},
          account_id: account_id || null,
          contact_id: contact_id || null,
          lead_id: lead_id || null,
          service_delivery_id: closureServiceDeliveryId,
          status: 'in_progress',
        })
        .select('id')
        .single()

      if (error) throw error
      return NextResponse.json({ id: created.id, created: true })
    }
  } catch (err) {
    console.error('[wizard-progress] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Save failed' },
      { status: 500 }
    )
  }
}
