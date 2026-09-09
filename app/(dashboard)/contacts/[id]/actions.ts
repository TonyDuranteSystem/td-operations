'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'

const ALLOWED_FIELDS = [
  'full_name', 'email', 'email_2', 'phone', 'phone_2',
  'language', 'citizenship', 'residency',
  'address_line1', 'address_city', 'address_state', 'address_zip', 'address_country',
  'date_of_birth', 'passport_number', 'passport_expiry_date',
  'itin_number', 'itin_issue_date', 'passport_on_file',
  'notes', 'status',
]

export async function updateContactField(
  contactId: string,
  field: string,
  value: string,
  updatedAt: string
): Promise<ActionResult> {
  if (!ALLOWED_FIELDS.includes(field)) {
    return { success: false, error: `Field '${field}' is not editable` }
  }

  return safeAction(async () => {
    const result = await updateWithLock('contacts', contactId, { [field]: value || null }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath(`/contacts/${contactId}`)
  }, {
    action_type: 'update', table_name: 'contacts', record_id: contactId,
    summary: `${field} updated`, details: { [field]: value },
  })
}

export async function addContactNote(
  contactId: string,
  note: string,
  // No longer used for the lock below — see the comment at that call.
  // Kept so existing callers don't need to change; safe to remove once
  // nothing passes it.
  _updatedAt: string
): Promise<ActionResult> {
  if (!note.trim()) {
    return { success: false, error: 'Note cannot be empty' }
  }

  return safeAction(async () => {
    const supabase = createClient()
    const { data: contact } = await supabase
      .from('contacts')
      .select('notes, updated_at')
      .eq('id', contactId)
      .single()

    if (!contact) throw new Error('Contact not found')

    const dateStr = new Date().toISOString().split('T')[0]
    const newEntry = `${dateStr}: ${note.trim()}`
    const existing = contact.notes?.trim() ?? ''
    const combined = existing ? `${newEntry}\n${existing}` : newEntry

    // Locked against THIS read's own updated_at, not the page-load value the
    // caller passed in — an append only needs to catch a write racing this
    // read-modify-write, not an unrelated field changed since page load
    // (bug-hunter pass, dev job e7352aa6: the page-load value goes stale
    // after a first note add with no reload, wrongly refusing an immediate
    // second one whose `combined` was already computed correctly from a
    // fresh read).
    const result = await updateWithLock('contacts', contactId, { notes: combined }, contact.updated_at)
    if (!result.success) throw new Error(result.error)
    revalidatePath(`/contacts/${contactId}`)
  }, {
    action_type: 'update', table_name: 'contacts', record_id: contactId,
    summary: 'Note added', details: { note },
  })
}
