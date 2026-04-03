/**
 * Credit Note System
 *
 * Two-step process:
 * 1. createCreditNote() — issues a credit note against an original invoice
 * 2. applyCreditNote() — applies the credit to a target invoice (reduces amount_due)
 *
 * Credit notes are issued first, applied separately.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { syncInvoiceStatus } from '@/lib/portal/unified-invoice'
import { logInvoiceAudit } from '@/lib/portal/invoice-audit'

/**
 * Generate credit note number: CN-2026-001 (sequential per owner)
 */
export async function generateCreditNoteNumber(
  ownerId: string,
  ownerType: 'account' | 'contact' = 'account'
): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `CN-${year}-`
  const col = ownerType === 'account' ? 'account_id' : 'contact_id'

  const { data } = await supabaseAdmin
    .from('client_credit_notes')
    .select('credit_note_number')
    .eq(col, ownerId)
    .like('credit_note_number', `${prefix}%`)
    .order('credit_note_number', { ascending: false })
    .limit(1)

  let seq = 1
  if (data?.length && data[0].credit_note_number) {
    const lastNum = data[0].credit_note_number.replace(prefix, '')
    const parsed = parseInt(lastNum, 10)
    if (!isNaN(parsed)) seq = parsed + 1
  }
  return `${prefix}${String(seq).padStart(3, '0')}`
}

/**
 * Create a credit note against an original invoice.
 * Does NOT auto-apply — use applyCreditNote() to apply it to a target invoice.
 */
export async function createCreditNote(input: {
  account_id?: string
  contact_id?: string
  original_invoice_id: string
  amount: number
  reason: string
}): Promise<{ id: string; credit_note_number: string }> {
  // 1. Validate original invoice exists
  const { data: originalInvoice, error: invErr } = await supabaseAdmin
    .from('client_invoices')
    .select('id, total, account_id, contact_id')
    .eq('id', input.original_invoice_id)
    .single()

  if (invErr || !originalInvoice) {
    throw new Error(`Original invoice not found: ${invErr?.message || 'not found'}`)
  }

  // 2. Validate amount <= original invoice total
  if (input.amount > Number(originalInvoice.total)) {
    throw new Error(`Credit note amount (${input.amount}) exceeds invoice total (${originalInvoice.total})`)
  }

  // Resolve owner
  const accountId = input.account_id || originalInvoice.account_id
  const contactId = input.contact_id || originalInvoice.contact_id
  const ownerType = accountId ? 'account' as const : 'contact' as const
  const ownerId = (accountId || contactId)!

  // 3. Generate credit note number
  const creditNoteNumber = await generateCreditNoteNumber(ownerId, ownerType)

  // 4. Insert into client_credit_notes
  const { data: creditNote, error: cnErr } = await supabaseAdmin
    .from('client_credit_notes')
    .insert({
      account_id: accountId || null,
      contact_id: contactId || null,
      credit_note_number: creditNoteNumber,
      original_invoice_id: input.original_invoice_id,
      amount: input.amount,
      reason: input.reason,
      status: 'issued',
    })
    .select('id, credit_note_number')
    .single()

  if (cnErr || !creditNote) {
    throw new Error(`Failed to create credit note: ${cnErr?.message}`)
  }

  // Audit trail
  logInvoiceAudit({
    invoice_id: input.original_invoice_id,
    action: 'credit_applied',
    new_values: { credit_note_id: creditNote.id, credit_note_number: creditNote.credit_note_number, amount: input.amount, reason: input.reason },
    performed_by: 'system',
  })

  return { id: creditNote.id, credit_note_number: creditNote.credit_note_number }
}

/**
 * Apply a credit note to a target invoice.
 * Reduces the target invoice's amount_due by the credit amount.
 * If amount_due reaches 0, marks invoice as Paid.
 */
export async function applyCreditNote(
  creditNoteId: string,
  targetInvoiceId: string
): Promise<void> {
  // 1. Fetch credit note (must be status='issued')
  const { data: cn, error: cnErr } = await supabaseAdmin
    .from('client_credit_notes')
    .select('id, amount, status')
    .eq('id', creditNoteId)
    .single()

  if (cnErr || !cn) {
    throw new Error(`Credit note not found: ${cnErr?.message || 'not found'}`)
  }
  if (cn.status !== 'issued') {
    throw new Error(`Credit note is already ${cn.status}, cannot apply`)
  }

  // 2. Fetch target invoice
  const { data: targetInv, error: invErr } = await supabaseAdmin
    .from('client_invoices')
    .select('id, total, amount_paid, amount_due')
    .eq('id', targetInvoiceId)
    .single()

  if (invErr || !targetInv) {
    throw new Error(`Target invoice not found: ${invErr?.message || 'not found'}`)
  }

  // 3. Apply credit: increase amount_paid, decrease amount_due
  const creditAmount = Number(cn.amount)
  const currentPaid = Number(targetInv.amount_paid) || 0
  const newAmountPaid = currentPaid + creditAmount
  const total = Number(targetInv.total)
  const newAmountDue = Math.max(total - newAmountPaid, 0)

  // 4. Determine new status and sync
  const today = new Date().toISOString().split('T')[0]
  if (newAmountDue <= 0) {
    await syncInvoiceStatus('invoice', targetInvoiceId, 'Paid', today, creditAmount)
  } else {
    await syncInvoiceStatus('invoice', targetInvoiceId, 'Partial', today, creditAmount)
  }

  // 5. Update credit note: status='applied', link to target invoice
  await supabaseAdmin
    .from('client_credit_notes')
    .update({
      status: 'applied',
      applied_to_invoice_id: targetInvoiceId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', creditNoteId)
}
