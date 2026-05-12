'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createAccountSchema, type CreateAccountInput } from '@/lib/schemas/account-create'
import { normalizeEIN } from '@/lib/jobs/validation'
import { triggerEINReceivedWorkflow } from '@/lib/operations/ein-received'
import { syncTier, syncContactTiersForAccount } from '@/lib/operations/sync-tier'
import type { Json } from '@/lib/database.types'

export async function updateAccountField(
  accountId: string,
  field: string,
  value: string,
  updatedAt: string
): Promise<ActionResult> {
  const allowedFields = [
    'company_name', 'entity_type', 'member_structure', 'account_type', 'status', 'ein_number', 'filing_id',
    'state_of_formation', 'formation_date', 'physical_address',
    'registered_agent_provider', 'ra_renewal_date', 'ra_switch_date', 'client_since', 'notes',
    'installment_1_amount', 'installment_1_currency',
    'installment_2_amount', 'installment_2_currency',
    'communication_email',
    // Path 2 address FK columns
    'business_legal_address_id', 'business_mailing_address_id', 'registered_agent_id',
    // Path 2 verified flags
    'legal_link_verified', 'mailing_link_verified', 'ra_link_verified',
  ]
  if (!allowedFields.includes(field)) {
    return { success: false, error: `Field '${field}' is not editable` }
  }

  const booleanFields = new Set(['legal_link_verified', 'mailing_link_verified', 'ra_link_verified'])

  // EIN inputs are normalized to canonical XX-XXXXXXX. A non-empty input that
  // fails normalization is rejected — matches the dedicated record-ein-received
  // endpoint's validation contract.
  let coercedValue: string | boolean | null
  if (booleanFields.has(field)) {
    coercedValue = value === 'true'
  } else if (field === 'ein_number' && value && value.trim()) {
    const normalized = normalizeEIN(value)
    if (!normalized) {
      return { success: false, error: `Invalid EIN format: "${value}". Expected 9 digits (e.g., 30-1482516).` }
    }
    coercedValue = normalized
  } else {
    coercedValue = value || null
  }

  const result = await safeAction(async () => {
    const writeResult = await updateWithLock('accounts', accountId, { [field]: coercedValue }, updatedAt)
    if (!writeResult.success) throw new Error(writeResult.error)
    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: 'accounts', record_id: accountId,
    summary: `${field} updated`, details: { [field]: coercedValue },
  })

  // Inline EIN edit on a formation-tier account triggers the same workflow as
  // the explicit "Record EIN Received" button (Banking SD + advance Formation
  // SD + tier→active + welcome package). MMLLC member-info portal message is
  // intentionally omitted — that side-effect should go through the dedicated
  // dialog UI. Best-effort: failures are logged but don't break the EIN save.
  if (result.success && field === 'ein_number' && typeof coercedValue === 'string' && coercedValue) {
    try {
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('portal_tier')
        .eq('id', accountId)
        .single()

      if (account?.portal_tier === 'formation') {
        const wf = await triggerEINReceivedWorkflow({
          accountId,
          einNumber: coercedValue,
          actor: 'dashboard:inline-edit',
          reason: 'EIN entered via inline edit on Account page',
        })
        if (!wf.success) {
          await supabaseAdmin.from('action_log').insert({
            actor: 'dashboard:inline-edit',
            action_type: 'record_ein_received',
            table_name: 'accounts',
            record_id: accountId,
            account_id: accountId,
            summary: `EIN ${coercedValue} saved via inline edit but workflow trigger skipped: ${wf.error ?? 'unknown'}`,
            details: { ein_number: coercedValue, error: wf.error, side_effects: wf.side_effects, source: 'inline-edit-skip' },
          })
        }
        revalidatePath(`/accounts/${accountId}`)
      }
    } catch (err) {
      await supabaseAdmin.from('action_log').insert({
        actor: 'dashboard:inline-edit',
        action_type: 'record_ein_received',
        table_name: 'accounts',
        record_id: accountId,
        account_id: accountId,
        summary: `EIN ${coercedValue} saved via inline edit but workflow trigger threw: ${err instanceof Error ? err.message : 'unknown'}`,
        details: { ein_number: coercedValue, error: err instanceof Error ? err.message : 'unknown', source: 'inline-edit-throw' },
      })
    }
  }

  return result
}

// Dedicated bulk-update helper for the lifecycle date pair (client_since +
// ra_switch_date). Single round-trip when both are edited together (e.g. from
// a future form). Inline edits continue to go through updateAccountField.
export async function updateAccountDates(
  accountId: string,
  dates: { client_since?: string | null; ra_switch_date?: string | null },
  updatedAt: string,
): Promise<ActionResult> {
  const patch: Record<string, string | null> = {}
  if (Object.prototype.hasOwnProperty.call(dates, 'client_since')) {
    patch.client_since = dates.client_since || null
  }
  if (Object.prototype.hasOwnProperty.call(dates, 'ra_switch_date')) {
    patch.ra_switch_date = dates.ra_switch_date || null
  }
  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'No date fields supplied' }
  }

  return safeAction(async () => {
    const writeResult = await updateWithLock('accounts', accountId, patch, updatedAt)
    if (!writeResult.success) throw new Error(writeResult.error)
    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: 'accounts', record_id: accountId,
    summary: 'Account lifecycle dates updated', details: patch,
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
    // ─── Email change: sync contacts.email → auth.users.email ───
    if (field === 'email' && value) {
      // Step 1: Capture old email for potential revert
      const { data: currentContact } = await supabaseAdmin
        .from('contacts')
        .select('email')
        .eq('id', contactId)
        .single()
      const oldEmail = currentContact?.email || null

      // Step 2: Look up portal user by contact_id
      // NOTE: supabaseAdmin.auth.admin.listUsers() return type destructures to
      // a union where `data` can be `never` under strict TS if not narrowed.
      // Cast the inner users array to the expected User shape for type safety.
      const listUsersResult = await supabaseAdmin.auth.admin.listUsers()
      const users = (listUsersResult.data?.users ?? []) as Array<{
        id: string
        app_metadata?: { contact_id?: string }
      }>
      const authUser = users.find(u => u.app_metadata?.contact_id === contactId)

      // Step 3: If portal user exists, update auth email FIRST
      if (authUser) {
        const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
          authUser.id,
          { email: value }
        )
        if (authError) {
          throw new Error(`Cannot change email: ${authError.message}`)
        }
      }

      // Step 4: Update contacts.email
      const result = await updateWithLock('contacts', contactId, { email: value }, updatedAt)
      if (!result.success) {
        // Step 5: Revert auth if contacts update failed
        if (authUser && oldEmail) {
          const { error: revertError } = await supabaseAdmin.auth.admin.updateUserById(
            authUser.id,
            { email: oldEmail }
          )
          if (revertError) {
            // Desync: auth has new email, contacts has old email — log for remediation
            try {
              await supabaseAdmin.from('action_log').insert({
                actor: 'system',
                action_type: 'update',
                table_name: 'contacts',
                record_id: contactId,
                summary: `DESYNC: auth.users.email updated to ${value} but contacts.email update failed and auth revert failed. Manual remediation needed.`,
                details: { contact_id: contactId, auth_user_id: authUser.id, old_email: oldEmail, new_email: value, revert_error: revertError.message },
              })
            } catch { /* non-blocking — best effort logging */ }
          }
        }
        throw new Error(result.error)
      }

      // Step 6: Cross-account revalidation for email changes
      const { data: links } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id')
        .eq('contact_id', contactId)
      for (const link of links ?? []) {
        revalidatePath(`/accounts/${link.account_id}`)
      }
      return
    }

    // ─── Non-email fields: existing behavior ───
    const result = await updateWithLock('contacts', contactId, { [field]: value || null }, updatedAt)
    if (!result.success) throw new Error(result.error)
    if (accountId) revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: 'contacts', record_id: contactId,
    summary: `${field} updated`, details: { [field]: value },
  })
}

const ACCOUNT_CONTACT_ROLES = ['', 'owner', 'authorized_representative', 'manager', 'accountant']

export async function updateAccountContactRole(
  accountId: string,
  contactId: string,
  role: string
): Promise<ActionResult> {
  if (!ACCOUNT_CONTACT_ROLES.includes(role)) {
    return { success: false, error: `Invalid role: ${role}` }
  }

  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from('account_contacts')
      .update({ role: role || null })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
    if (error) throw new Error(error.message)
    revalidatePath(`/accounts/${accountId}`)
    revalidatePath(`/contacts/${contactId}`)
  }, {
    action_type: 'update', table_name: 'account_contacts', record_id: contactId,
    summary: `Contact role updated to ${role || '(none)'}`,
    details: { accountId, contactId, role },
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
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
    // Read current doc for portal-notification context. Write goes through
    // updateDocument() which owns the action_log entry (same contract as
    // MCP sites) — so safeAction is called without its `audit` config to
    // avoid a duplicate log row.
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const actor = `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`

    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, account_id, contact_id')
      .eq('id', documentId)
      .single()

    const { updateDocument } = await import('@/lib/operations/document')
    const result = await updateDocument({
      id: documentId,
      patch: { portal_visible: visible },
      actor,
      summary: `Portal visibility ${visible ? 'enabled' : 'disabled'}`,
    })
    if (!result.success) throw new Error(result.error || 'Failed to update document visibility')

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
  // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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

/**
 * Promote an onboarding-tier account whose EIN has been recorded to the
 * 'active' tier. UI equivalent of what `onboarding_form_review` does at the
 * end of its background job — provided for cases where the form was reviewed
 * manually (no MCP run) or got stuck on tier promotion. Gated client-side on
 * portal_tier='onboarding' + ein_number set; server re-checks both before the
 * tier write to avoid stale-UI errors.
 */
export async function promoteAccountToActive(accountId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const actor = `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`

    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('portal_tier, ein_number, company_name')
      .eq('id', accountId)
      .single()

    if (!account) throw new Error('Account not found')
    if (account.portal_tier !== 'onboarding') {
      throw new Error(`Account tier is "${account.portal_tier ?? 'null'}", not "onboarding" — promote not allowed`)
    }
    if (!account.ein_number) {
      throw new Error('Account has no EIN — record EIN before promoting to active')
    }

    const result = await syncTier({
      accountId,
      newTier: 'active',
      reason: 'CRM: promote to active (post-onboarding)',
      actor,
    })
    if (!result.success) throw new Error(result.error ?? 'syncTier failed')

    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update', table_name: 'accounts', record_id: accountId,
    summary: 'Promoted onboarding → active',
  })
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
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { error } = await supabaseAdmin
        .from('payments')
        .update({ status: 'Cancelled' })
        .eq('account_id', accountId)
        .in('status', ['Pending', 'Overdue'])
      if (error) throw new Error(error.message)
    })
  }

  // Capture actor once for cascades that need to log it (recompute helpers).
  // Pulled before the cascades so revoke/suspend can attribute the contact
  // tier recompute to the same dashboard user that triggered the status change.
  const cascadeSupabase = createClient()
  const { data: { user: cascadeUser } } = await cascadeSupabase.auth.getUser()
  const cascadeActor = `dashboard:${cascadeUser?.email?.split('@')[0] ?? 'unknown'}`

  if (options.revokePortalAccess) {
    await runCascade('revoke_portal_access', async () => {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { error } = await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: 'inactive', portal_account: false })
        .eq('id', accountId)
      if (error) throw new Error(error.message)
      // Recompute portal_tier on every linked contact so the contact + auth
      // metadata reflect the loss of this account. computeContactTier inside
      // the helper excludes lifecycle markers ('inactive'/'suspended') and
      // returns the MAX of the remaining valid account tiers.
      await syncContactTiersForAccount(accountId, cascadeActor)
    })
  }

  if (options.suspendPortal) {
    await runCascade('suspend_portal', async () => {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { error } = await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: 'suspended' })
        .eq('id', accountId)
      if (error) throw new Error(error.message)
      await syncContactTiersForAccount(accountId, cascadeActor)
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
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
        const { syncTier } = await import('@/lib/operations/sync-tier')
        const result = await syncTier({ accountId, newTier: 'active', reason: 'account reactivated from suspended' })
        if (!result.success) throw new Error(result.error)
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
      details: { oldStatus, newStatus, options, cascadesApplied, cascadesFailed, note } as unknown as Json,
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
