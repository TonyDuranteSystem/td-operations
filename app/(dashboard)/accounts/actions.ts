'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
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
    // Use supabaseAdmin for both read and write — the documents table has no
    // UPDATE RLS policy for staff users (only SELECT + service_role ALL).
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, account_id, contact_id')
      .eq('id', documentId)
      .single()

    const { error } = await supabaseAdmin
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

export async function linkContactToAccount(
  accountId: string,
  contactId: string,
  role: string = 'owner',
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()

    // Check if already linked
    const { data: existing } = await supabase
      .from('account_contacts')
      .select('account_id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()

    if (existing) throw new Error('Contact is already linked to this account')

    const { error } = await supabase
      .from('account_contacts')
      .insert({ account_id: accountId, contact_id: contactId, role })

    if (error) throw new Error(error.message)
    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'create', table_name: 'account_contacts', record_id: `${accountId}:${contactId}`,
    summary: `Linked contact ${contactId} to account ${accountId} as ${role}`,
  })
}

export async function searchContacts(
  query: string,
): Promise<{ id: string; full_name: string; email: string | null }[]> {
  const supabase = createClient()
  const { data } = await supabase
    .from('contacts')
    .select('id, full_name, email')
    .ilike('full_name', `%${query}%`)
    .limit(10)
  return data || []
}

export async function unlinkContactFromAccount(
  accountId: string,
  contactId: string,
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const { error } = await supabase
      .from('account_contacts')
      .delete()
      .eq('account_id', accountId)
      .eq('contact_id', contactId)

    if (error) throw new Error(error.message)
    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'delete', table_name: 'account_contacts', record_id: `${accountId}:${contactId}`,
    summary: `Unlinked contact ${contactId} from account ${accountId}`,
  })
}

export async function createAndLinkContact(
  accountId: string,
  fullName: string,
  email: string | null,
  role: string = 'owner',
): Promise<ActionResult & { contactId?: string }> {
  const supabase = createClient()

  // Parse name into first/last
  const parts = fullName.trim().split(/\s+/)
  const firstName = parts[0] || ''
  const lastName = parts.slice(1).join(' ') || ''

  // Create the contact
  const { data: contact, error: createErr } = await supabase
    .from('contacts')
    .insert({
      full_name: fullName.trim(),
      first_name: firstName,
      last_name: lastName,
      email: email || null,
      status: 'active',
    })
    .select('id')
    .single()

  if (createErr || !contact) {
    return { success: false, error: createErr?.message || 'Failed to create contact' }
  }

  // Link to the account
  const { error: linkErr } = await supabase
    .from('account_contacts')
    .insert({ account_id: accountId, contact_id: contact.id, role })

  if (linkErr) {
    return { success: false, error: linkErr.message }
  }

  revalidatePath(`/accounts/${accountId}`)
  return { success: true, contactId: contact.id }
}

// ── Status Change with Cascades ────────────────────────────────────
// Atomic-ish status change: writes new status, runs opt-in side effects,
// logs everything to action_log, appends a dated note to accounts.notes.
// Each cascade is best-effort — if one fails we report it but keep going.

export interface StatusChangeOptions {
  // Suspended cascades
  blockNewServices?: boolean
  suspendPortal?: boolean
  // Cancelled cascades (also used by Closed)
  cancelDeliveries?: boolean
  cancelDeadlines?: boolean
  createRACancelTask?: boolean
  // Closed-only cascades
  closeOpenTasks?: boolean
  voidPendingPayments?: boolean
  revokePortalAccess?: boolean
  runClosureDocs?: boolean
}

export interface StatusChangePreview {
  activeDeliveries: number
  pendingDeadlines: number
  openTasks: number
  pendingPayments: number
}

export interface StatusChangeResult extends ActionResult {
  cascadesApplied?: string[]
  cascadesFailed?: { name: string; error: string }[]
}

/**
 * Preview impact counts for a status change. Read-only.
 * Used by the StatusChangeDialog to warn the user before they confirm.
 */
export async function previewStatusChange(
  accountId: string,
  _newStatus: string,
): Promise<{ success: boolean; preview?: StatusChangePreview; error?: string }> {
  try {
    const [deliveries, deadlines, tasks, payments] = await Promise.all([
      supabaseAdmin
        .from('service_deliveries')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('status', 'active'),
      supabaseAdmin
        .from('deadlines')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('status', 'Pending'),
      supabaseAdmin
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .in('status', ['To Do', 'In Progress', 'Waiting']),
      supabaseAdmin
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .in('status', ['Pending', 'Overdue']),
    ])

    return {
      success: true,
      preview: {
        activeDeliveries: deliveries.count ?? 0,
        pendingDeadlines: deadlines.count ?? 0,
        openTasks: tasks.count ?? 0,
        pendingPayments: payments.count ?? 0,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Change an account's status and run the selected cascade side effects.
 * The status write uses optimistic locking; cascades use supabaseAdmin
 * because some target tables (e.g. tasks, deadlines) have strict RLS.
 */
export async function changeAccountStatus(
  accountId: string,
  newStatus: string,
  options: StatusChangeOptions,
  note: string,
  updatedAt: string,
): Promise<StatusChangeResult> {
  const cascadesApplied: string[] = []
  const cascadesFailed: { name: string; error: string }[] = []

  // 1. Fetch current row — we need company_name + state for the RA task
  const { data: account, error: fetchErr } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, state_of_formation, status, notes')
    .eq('id', accountId)
    .single()

  if (fetchErr || !account) {
    return { success: false, error: fetchErr?.message || 'Account not found' }
  }

  const oldStatus = account.status

  // 2. Write the new status (with optimistic lock). Append note if provided.
  const dateStr = new Date().toISOString().split('T')[0]
  const autoNoteLine = `${dateStr}: Status changed from ${oldStatus || '(unset)'} to ${newStatus}${note.trim() ? ` — ${note.trim()}` : ''}`
  const existingNotes = (account.notes ?? '').trim()
  const combinedNotes = existingNotes ? `${autoNoteLine}\n${existingNotes}` : autoNoteLine

  const lockResult = await updateWithLock(
    'accounts',
    accountId,
    { status: newStatus, notes: combinedNotes },
    updatedAt,
  )
  if (!lockResult.success) {
    return { success: false, error: lockResult.error || 'Failed to update account status' }
  }

  // Helper: run a cascade and record the outcome
  const runCascade = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
      cascadesApplied.push(name)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      cascadesFailed.push({ name, error: message })
    }
  }

  // 3. Run cascades based on options
  if (options.cancelDeliveries) {
    await runCascade('cancel_deliveries', async () => {
      const { error } = await supabaseAdmin
        .from('service_deliveries')
        .update({ status: 'cancelled' })
        .eq('account_id', accountId)
        .eq('status', 'active')
      if (error) throw new Error(error.message)
    })
  }

  if (options.cancelDeadlines) {
    await runCascade('cancel_deadlines', async () => {
      const { error } = await supabaseAdmin
        .from('deadlines')
        .update({ status: 'Cancelled' })
        .eq('account_id', accountId)
        .eq('status', 'Pending')
      if (error) throw new Error(error.message)
    })
  }

  if (options.createRACancelTask) {
    await runCascade('create_ra_cancel_task', async () => {
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + 7)
      const { error } = await supabaseAdmin.from('tasks').insert({
        account_id: accountId,
        task_title: `Cancel Harbor Compliance RA — ${account.company_name}`,
        description: `Account status changed to ${newStatus}. Action required:\n1. File Statement of Change of Registered Agent with ${account.state_of_formation ?? 'the state'}.\n2. Notify Harbor Compliance that they should resign as RA.\n3. Confirm in CRM once complete.`,
        category: 'Filing',
        priority: 'High',
        status: 'To Do',
        assigned_to: 'Luca',
        due_date: dueDate.toISOString().split('T')[0],
      })
      if (error) throw new Error(error.message)
    })
  }

  if (options.closeOpenTasks) {
    await runCascade('close_open_tasks', async () => {
      const { error } = await supabaseAdmin
        .from('tasks')
        .update({ status: 'Cancelled' })
        .eq('account_id', accountId)
        .in('status', ['To Do', 'In Progress', 'Waiting'])
      if (error) throw new Error(error.message)
    })
  }

  if (options.voidPendingPayments) {
    await runCascade('void_pending_payments', async () => {
      const { error } = await supabaseAdmin
        .from('payments')
        .update({ status: 'Cancelled' })
        .eq('account_id', accountId)
        .in('status', ['Pending', 'Overdue'])
      if (error) throw new Error(error.message)
    })
  }

  if (options.revokePortalAccess) {
    await runCascade('revoke_portal_access', async () => {
      const { error } = await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: 'inactive', portal_account: false })
        .eq('id', accountId)
      if (error) throw new Error(error.message)
    })
  }

  if (options.suspendPortal) {
    await runCascade('suspend_portal', async () => {
      const { error } = await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: 'suspended' })
        .eq('id', accountId)
      if (error) throw new Error(error.message)
    })
  }

  // blockNewServices is enforced at sd_create time (gated on account status).
  // Record it as "applied" so it appears in the cascade summary.
  if (options.blockNewServices) {
    cascadesApplied.push('block_new_services')
  }

  // runClosureDocs — fire-and-forget. The closure_prepare_documents MCP tool
  // is invoked via a task so Luca can trigger it (or an automation later).
  if (options.runClosureDocs) {
    await runCascade('request_closure_docs', async () => {
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + 3)
      const { error } = await supabaseAdmin.from('tasks').insert({
        account_id: accountId,
        task_title: `Generate closure documents — ${account.company_name}`,
        description: `Account was Closed. Run closure_prepare_documents via MCP to generate Articles of Dissolution, EIN closure letter, and upload to the client's Drive folder.`,
        category: 'Document',
        priority: 'High',
        status: 'To Do',
        assigned_to: 'Luca',
        due_date: dueDate.toISOString().split('T')[0],
      })
      if (error) throw new Error(error.message)
    })
  }

  // 4. Reactivation case — if going BACK to Active, clear suspended tier flag
  if (newStatus === 'Active' && oldStatus && oldStatus !== 'Active') {
    await runCascade('restore_portal_tier', async () => {
      const { data: current } = await supabaseAdmin
        .from('accounts')
        .select('portal_tier')
        .eq('id', accountId)
        .single()
      if (current?.portal_tier === 'suspended') {
        const { error } = await supabaseAdmin
          .from('accounts')
          .update({ portal_tier: 'active' })
          .eq('id', accountId)
        if (error) throw new Error(error.message)
      }
    })
  }

  // 5. Audit log entry
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const actor = `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`
    await supabaseAdmin.from('action_log').insert({
      actor,
      action_type: 'update',
      table_name: 'accounts',
      record_id: accountId,
      account_id: accountId,
      summary: `Status changed: ${oldStatus} → ${newStatus}`,
      details: { oldStatus, newStatus, options, cascadesApplied, cascadesFailed, note },
    })
  } catch {
    // Audit log is non-blocking
  }

  revalidatePath(`/accounts/${accountId}`)

  return {
    success: cascadesFailed.length === 0,
    error: cascadesFailed.length > 0
      ? `Status changed but ${cascadesFailed.length} cascade(s) failed: ${cascadesFailed.map(c => c.name).join(', ')}`
      : undefined,
    cascadesApplied,
    cascadesFailed,
  }
}
