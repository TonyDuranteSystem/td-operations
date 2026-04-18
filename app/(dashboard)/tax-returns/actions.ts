'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import type { DryRunResult } from '@/lib/operations/destructive'

const TOGGLE_ALLOWLIST = ['paid', 'data_received', 'sent_to_india', 'extension_filed'] as const
type ToggleField = (typeof TOGGLE_ALLOWLIST)[number]

export async function updateTaxReturnStatus(
  id: string,
  status: string,
  updatedAt: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const result = await updateWithLock('tax_returns', id, { status }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/tax-returns')
  }, {
    action_type: 'update', table_name: 'tax_returns', record_id: id,
    summary: `Status → ${status}`, details: { status },
  })
}

export async function toggleTaxReturnField(
  id: string,
  field: string,
  value: boolean,
  updatedAt: string
): Promise<ActionResult> {
  // Validate field name against allowlist
  if (!TOGGLE_ALLOWLIST.includes(field as ToggleField)) {
    return { success: false, error: `Invalid field: ${field}. Allowed: ${TOGGLE_ALLOWLIST.join(', ')}` }
  }

  return safeAction(async () => {
    const result = await updateWithLock('tax_returns', id, { [field]: value }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/tax-returns')
  }, {
    action_type: 'update', table_name: 'tax_returns', record_id: id,
    summary: `${field} → ${value}`, details: { [field]: value },
  })
}

export async function addTaxReturnNote(
  id: string,
  note: string,
  updatedAt: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()

    // Read current notes
    const { data: current, error: readError } = await supabase
      .from('tax_returns')
      .select('notes')
      .eq('id', id)
      .single()
    if (readError) throw new Error(readError.message)

    const datePrefix = new Date().toISOString().split('T')[0]
    const newNote = `[${datePrefix}] ${note.trim()}`
    const updatedNotes = current?.notes
      ? `${newNote}\n${current.notes}`
      : newNote

    const result = await updateWithLock('tax_returns', id, { notes: updatedNotes }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/tax-returns')
  }, {
    action_type: 'update', table_name: 'tax_returns', record_id: id,
    summary: `Note added`, details: { note },
  })
}

export async function updateTaxReturn(
  id: string,
  updates: Record<string, unknown>,
  updatedAt: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const result = await updateWithLock('tax_returns', id, updates, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/tax-returns')
  }, {
    action_type: 'update', table_name: 'tax_returns', record_id: id,
    summary: `Updated: ${Object.keys(updates).join(', ')}`,
    details: updates,
  })
}

// ─── P3.9 — delete tax return ──────────────────────────

export async function deleteTaxReturnPreview(
  id: string,
): Promise<{ success: boolean; preview?: DryRunResult; error?: string }> {
  try {
    const supabase = createClient()
    const { data: tr } = await supabase
      .from('tax_returns')
      .select('id, company_name, client_name, return_type, tax_year, status, deadline, paid, data_received, sent_to_india, extension_filed')
      .eq('id', id)
      .maybeSingle()
    if (!tr) return { success: false, error: 'Tax return not found' }

    const statusValue = tr.status ?? 'no status'
    const isFiled = statusValue === 'TR Filed'

    return {
      success: true,
      preview: {
        affected: { tax_return: 1 },
        items: [
          {
            label: `${tr.company_name ?? 'Unknown company'} — ${tr.return_type ?? 'Tax Return'} ${tr.tax_year ?? ''}`.trim(),
            details: [
              statusValue,
              tr.deadline ? `deadline ${tr.deadline}` : '',
              tr.paid ? 'paid' : 'unpaid',
              tr.data_received ? 'data received' : 'no data',
              tr.sent_to_india ? 'sent to india' : '',
              tr.extension_filed ? 'extension filed' : '',
            ].filter(Boolean) as string[],
          },
        ],
        warnings: [
          'The tax return record is permanently removed from the tracker.',
          'Linked tasks and service deliveries are NOT affected.',
        ],
        blocker: isFiled
          ? 'This tax return is marked "TR Filed". Deleting a filed return corrupts history — leave it in place for audit trail.'
          : undefined,
        record_label: tr.company_name ?? id,
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Preview failed' }
  }
}

export async function deleteTaxReturn(id: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const { data: tr } = await supabase
      .from('tax_returns')
      .select('id, status')
      .eq('id', id)
      .maybeSingle()
    if (!tr) throw new Error('Tax return not found')
    if (tr.status === 'TR Filed') throw new Error('Filed tax returns cannot be deleted.')

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error } = await supabase.from('tax_returns').delete().eq('id', id)
    if (error) throw new Error(error.message)
    revalidatePath('/tax-returns')
  }, {
    action_type: 'delete',
    table_name: 'tax_returns',
    record_id: id,
    summary: 'Tax return deleted',
  })
}
