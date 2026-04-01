'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createAccountSchema, type CreateAccountInput } from '@/lib/schemas/account-create'

export async function updateAccountField(
  accountId: string,
  field: string,
  value: string,
  updatedAt: string
): Promise<ActionResult> {
  const allowedFields = [
    'company_name', 'entity_type', 'account_type', 'status', 'ein_number', 'filing_id',
    'state_of_formation', 'formation_date', 'physical_address',
    'registered_agent', 'ra_renewal_date', 'notes',
    'installment_1_amount', 'installment_1_currency',
    'installment_2_amount', 'installment_2_currency',
  ]
  if (!allowedFields.includes(field)) {
    return { success: false, error: `Field '${field}' is not editable` }
  }

  return safeAction(async () => {
    const result = await updateWithLock('accounts', accountId, { [field]: value || null }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: 'accounts', record_id: accountId,
    summary: `${field} updated`, details: { [field]: value },
  })
}

export async function updateContactField(
  contactId: string,
  field: string,
  value: string,
  updatedAt: string,
  accountId?: string
): Promise<ActionResult> {
  const allowedFields = ['full_name', 'email', 'phone', 'language', 'role']
  if (!allowedFields.includes(field)) {
    return { success: false, error: `Field '${field}' is not editable` }
  }

  return safeAction(async () => {
    const result = await updateWithLock('contacts', contactId, { [field]: value || null }, updatedAt)
    if (!result.success) throw new Error(result.error)
    if (accountId) revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: 'contacts', record_id: contactId,
    summary: `${field} updated`, details: { [field]: value },
  })
}

export async function createAccount(
  input: CreateAccountInput
): Promise<ActionResult<{ id: string }>> {
  const parsed = createAccountSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('accounts')
      .insert({ ...parsed.data, created_at: now, updated_at: now })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/accounts')
    return data
  }, {
    action_type: 'create', table_name: 'accounts',
    summary: `Created: ${parsed.data.company_name}`,
    details: { ...parsed.data },
  })
}

export async function addAccountNote(
  accountId: string,
  note: string,
  updatedAt: string
): Promise<ActionResult> {
  if (!note.trim()) {
    return { success: false, error: 'Note cannot be empty' }
  }

  return safeAction(async () => {
    const supabase = createClient()
    // Get current notes
    const { data: account } = await supabase
      .from('accounts')
      .select('notes, updated_at')
      .eq('id', accountId)
      .single()

    if (!account) throw new Error('Account not found')

    // Prepend dated entry
    const dateStr = new Date().toISOString().split('T')[0]
    const newEntry = `${dateStr}: ${note.trim()}`
    const existingNotes = account.notes?.trim() ?? ''
    const combined = existingNotes ? `${newEntry}\n${existingNotes}` : newEntry

    const result = await updateWithLock('accounts', accountId, { notes: combined }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: 'accounts', record_id: accountId,
    summary: 'Note added', details: { note },
  })
}

export async function toggleDocumentPortalVisibility(
  documentId: string,
  visible: boolean
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const { data: doc } = await supabase
      .from('documents')
      .select('id, file_name, account_id, contact_id')
      .eq('id', documentId)
      .single()

    const { error } = await supabase
      .from('documents')
      .update({ portal_visible: visible })
      .eq('id', documentId)

    if (error) throw new Error(error.message)

    // Notify client when document is shared (not when hidden)
    if (visible && doc) {
      const { createPortalNotification } = await import('@/lib/portal/notifications')
      await createPortalNotification({
        account_id: doc.account_id || undefined,
        contact_id: doc.contact_id || undefined,
        type: 'document',
        title: 'New document available',
        body: doc.file_name || 'A new document has been shared with you',
        link: '/portal/documents',
      })

      // Also send a portal chat message so client sees it in chat
      if (doc.account_id) {
        const { supabaseAdmin: adminClient } = await import('@/lib/supabase-admin')
        const adminUserId = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'
        await adminClient.from('portal_messages').insert({
          account_id: doc.account_id,
          contact_id: doc.contact_id || null,
          sender_type: 'admin',
          sender_id: adminUserId,
          message: `A new document has been added to your folder: ${doc.file_name}`,
        })
      }
    }
  }, {
    action_type: 'update', table_name: 'documents', record_id: documentId,
    summary: `Portal visibility ${visible ? 'enabled' : 'disabled'}`,
  })
}
