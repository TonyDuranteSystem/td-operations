'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { revalidatePath } from 'next/cache'

export interface RequestPayoutState {
  ok: boolean
  error?: string
  payoutId?: string
}

/**
 * A partner self-serves a payout request from their portal: USD bank details +
 * optional invoice upload. Security: the payout MUST belong to the calling
 * partner and be in 'pending' (the auto-created, not-yet-requested state).
 * On success the payout moves to 'requested' for staff to approve & pay in
 * CRM → Partners. Used with useActionState.
 */
export async function requestPartnerPayout(
  _prev: RequestPayoutState,
  formData: FormData,
): Promise<RequestPayoutState> {
  const payoutId = String(formData.get('payout_id') || '')

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.', payoutId }
  const contactId = getClientContactId(user)
  if (!contactId) return { ok: false, error: 'Not signed in.', payoutId }

  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select('id')
    .eq('contact_id', contactId)
    .single()
  if (!partner) return { ok: false, error: 'Partner account not found.', payoutId }

  if (!payoutId) return { ok: false, error: 'Missing payout.', payoutId }

  // SECURITY: the payout must belong to THIS partner and still be requestable.
  const { data: payout } = await supabaseAdmin
    .from('referral_payouts')
    .select('id, partner_id, status')
    .eq('id', payoutId)
    .single()
  if (!payout || payout.partner_id !== partner.id) {
    return { ok: false, error: 'Payout not found.', payoutId }
  }
  if ((payout.status || '').toLowerCase() !== 'pending') {
    return { ok: false, error: 'This payout has already been requested.', payoutId }
  }

  const bank = {
    account_name: String(formData.get('account_name') || '').trim(),
    account_number: String(formData.get('account_number') || '').trim(),
    iban: String(formData.get('iban') || '').trim(),
    swift_bic: String(formData.get('swift_bic') || '').trim(),
    bank_name: String(formData.get('bank_name') || '').trim(),
    note: String(formData.get('note') || '').trim(),
  }
  if (!bank.account_name || (!bank.account_number && !bank.iban)) {
    return { ok: false, error: 'Enter the account holder name and an account number or IBAN.', payoutId }
  }

  // Optional invoice upload (reuse the portal-uploads bucket).
  let invoiceUrl: string | null = null
  let invoiceName: string | null = null
  const file = formData.get('invoice')
  if (file && file instanceof File && file.size > 0) {
    if (file.size > 10 * 1024 * 1024) {
      return { ok: false, error: 'Invoice file is too large (max 10 MB).', payoutId }
    }
    const ext = (file.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf'
    const path = `partner-payouts/${partner.id}/${payoutId}.${ext}`
    const buf = Buffer.from(await file.arrayBuffer())
    const { error: upErr } = await supabaseAdmin.storage
      .from('portal-uploads')
      .upload(path, buf, { contentType: file.type || 'application/octet-stream', upsert: true })
    if (upErr) return { ok: false, error: `Invoice upload failed: ${upErr.message}`, payoutId }
    invoiceUrl = path
    invoiceName = file.name
  }

  const { error } = await supabaseAdmin
    .from('referral_payouts')
    .update({
      status: 'requested',
      payout_request: bank,
      invoice_url: invoiceUrl,
      invoice_name: invoiceName,
      requested_at: new Date().toISOString(),
    })
    .eq('id', payoutId)
    .eq('partner_id', partner.id) // defence in depth

  if (error) return { ok: false, error: error.message, payoutId }

  revalidatePath('/portal/partner/referrals')
  return { ok: true, payoutId }
}
