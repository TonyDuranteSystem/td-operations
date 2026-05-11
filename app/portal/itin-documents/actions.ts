'use server'

/**
 * Phase C (ITIN Chain Fix 2026-05-11) — server actions for the
 * /portal/itin-documents page.
 *
 * confirmItinMailed advances the contact's ITIN SD from "Client Signing" to
 * "Documents Received" once the client tells us they've mailed the printed
 * W-7 + 1040-NR + Schedule OI + passport copies to Antonio's CAA office.
 *
 * Authorization: the SD must belong to the authenticated portal contact and
 * must currently be at "Client Signing" stage. advanceServiceDelivery is
 * gated by both checks before being called so one contact can't trip another
 * contact's pipeline.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { advanceServiceDelivery } from '@/lib/service-delivery'
import { revalidatePath } from 'next/cache'

export interface ConfirmItinMailedResult {
  success: boolean
  error?: string
}

export async function confirmItinMailed(): Promise<ConfirmItinMailedResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const contactId = getClientContactId(user)
  if (!contactId) return { success: false, error: 'No contact linked to this user.' }

  // Look up the ITIN SD currently at Client Signing for this contact. Filter
  // by contact_id + service_type + stage + status='active' all at once so we
  // can't act on another contact's SD or one that has already moved forward.
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, stage, status')
    .eq('contact_id', contactId)
    .eq('service_type', 'ITIN')
    .eq('stage', 'Client Signing')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!sd) {
    return { success: false, error: 'No active ITIN service found at Client Signing stage.' }
  }

  const result = await advanceServiceDelivery({
    delivery_id: sd.id,
    target_stage: 'Documents Received',
    actor: 'portal-client',
    notes: 'Client confirmed via portal that signed documents were mailed.',
  })

  if (!result.success) {
    return { success: false, error: result.error || 'Failed to advance ITIN service.' }
  }

  revalidatePath('/portal/itin-documents')
  revalidatePath('/portal')
  return { success: true }
}
