'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'

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
