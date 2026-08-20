'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createAccountSchema, primaryContactSchema, type CreateAccountInput, type PrimaryContactInput } from '@/lib/schemas/account-create'
import { normalizeEIN } from '@/lib/jobs/validation'
import { triggerEINReceivedWorkflow } from '@/lib/operations/ein-received'
import { syncTier, syncContactTiersForAccount } from '@/lib/operations/sync-tier'
import { syncPortalLoginEmail } from '@/lib/operations/portal-login-email'
import { createSD } from '@/lib/operations/service-delivery'
import { createAccount as createAccountOp, createAndLinkContact as createAndLinkContactOp } from '@/lib/operations/account'
import type { Json } from '@/lib/database.types'

// Matches safeAction's own actor derivation (lib/server-action.ts) — needed
// here because the operations-layer functions take actor as a param instead
// of deriving it themselves.
async function getDashboardActor(): Promise<string> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`
}

export async function updateAccountField(
  accountId: string,
  field: string,
  value: string,
  updatedAt: string
): Promise<ActionResult> {
  const allowedFields = [
    'company_name', 'entity_type', 'member_structure', 'member_count', 'account_type', 'status', 'ein_number', 'filing_id',
    'state_of_formation', 'formation_date', 'physical_address',
    'registered_agent_provider', 'ra_renewal_date', 'ra_switch_date', 'client_since', 'notes',
    'installment_1_amount', 'installment_1_currency',
    'installment_2_amount', 'installment_2_currency',
    'communication_email',
    // Path 2 address FK columns
    'business_legal_address_id', 'business_mailing_address_id', 'registered_agent_id',
    // Path 2 verified flags
    'legal_link_verified', 'mailing_link_verified', 'ra_link_verified',
    // Dunning / payment-reminder config (Phase 4)
    'dunning_reminder_1_days', 'dunning_reminder_2_days', 'dunning_pause',
    // Dated reminder pause + trace ("client promised to pay by X", 2026-07-03)
    'dunning_pause_until', 'dunning_pause_reason',
  ]
  if (!allowedFields.includes(field)) {
    return { success: false, error: `Field '${field}' is not editable` }
  }

  const booleanFields = new Set(['legal_link_verified', 'mailing_link_verified', 'ra_link_verified', 'dunning_pause'])
  const integerFields = new Set(['member_count', 'dunning_reminder_1_days', 'dunning_reminder_2_days'])

  // EIN inputs are normalized to canonical XX-XXXXXXX. A non-empty input that
  // fails normalization is rejected — matches the dedicated record-ein-received
  // endpoint's validation contract.
  let coercedValue: string | boolean | number | null
  if (booleanFields.has(field)) {
    coercedValue = value === 'true'
  } else if (integerFields.has(field)) {
    coercedValue = value.trim() === '' ? null : parseInt(value, 10)
    if (coercedValue !== null && isNaN(coercedValue as number)) {
      return { success: false, error: `${field} must be a whole number` }
    }
    // Reminder-day fields must be a sane positive number of days.
    if (
      (field === 'dunning_reminder_1_days' || field === 'dunning_reminder_2_days') &&
      coercedValue !== null && (Number(coercedValue) < 1 || Number(coercedValue) > 365)
    ) {
      return { success: false, error: 'Reminder days must be between 1 and 365' }
    }
  } else if (field === 'dunning_pause_until') {
    // Must be a real YYYY-MM-DD date (or empty to clear the pause).
    const trimmed = value.trim()
    if (trimmed === '') {
      coercedValue = null
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || isNaN(new Date(`${trimmed}T00:00:00`).getTime())) {
      return { success: false, error: 'Pause-until must be a valid date (YYYY-MM-DD)' }
    } else {
      coercedValue = trimmed
    }
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
    // ─── Email change: update contacts.email, then sync the portal login ───
    if (field === 'email' && value) {
      // Update the contact email first (source of truth).
      const result = await updateWithLock('contacts', contactId, { email: value }, updatedAt)
      if (!result.success) throw new Error(result.error)

      // Keep the portal LOGIN email in sync via the shared helper: resolves the
      // login by contact_id, guards against conflicts, and notifies the client.
      // Best-effort — a conflict/failure does NOT roll back the contact email
      // (it's surfaced/flagged), matching the core updateContact behavior.
      const { data: c } = await supabaseAdmin
        .from('contacts')
        .select('full_name, language')
        .eq('id', contactId)
        .maybeSingle()
      await syncPortalLoginEmail({
        contactId,
        newEmail: value,
        language: c?.language ?? null,
        fullName: c?.full_name ?? null,
      })

      // Cross-account revalidation for email changes
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

/**
 * Creates a new account. The primary contact comes from EITHER a freshly
 * typed name/email (primaryContact) OR an existing contact picked from
 * search (existingContactId) — exactly one of the two is expected; when
 * existingContactId is set, primaryContact is ignored and no identity
 * matching runs at all (staff already resolved the ambiguity by picking
 * the exact record). This dialog is a manual/staff-driven creation path —
 * verified as the ONLY caller of createAccountOp in the whole codebase, so
 * unlike the client formation workflow (which collects the full member
 * roster, primary contact, and signer as part of its own process), an
 * account created here is NEVER covered by that collection step. A
 * Multi-Member account created here therefore always needs that follow-up
 * work done by hand — flagged via `needsMemberSetup` regardless of which
 * contact-entry method was used (Antonio, 2026-08-19, dev_task 693273fd).
 */
export async function createAccount(
  input: CreateAccountInput,
  primaryContact: PrimaryContactInput | null,
  existingContactId?: string | null,
): Promise<ActionResult<{ id: string }> & { warning?: string; needsMemberSetup?: boolean }> {
  const parsedAccount = createAccountSchema.safeParse(input)
  if (!parsedAccount.success) return { success: false, error: parsedAccount.error.issues[0].message }

  let parsedContact: PrimaryContactInput | null = null
  if (!existingContactId) {
    const result = primaryContactSchema.safeParse(primaryContact)
    if (!result.success) return { success: false, error: result.error.issues[0].message }
    parsedContact = result.data
  }

  const actor = await getDashboardActor()
  const created = await createAccountOp({ ...parsedAccount.data, actor })

  if (!created.success || !created.account_id) {
    return { success: false, error: created.error || 'Failed to create account' }
  }

  revalidatePath('/accounts')

  const isMultiMember = parsedAccount.data.member_structure === 'multi_member'

  if (existingContactId) {
    // Staff explicitly picked this exact person — no ambiguity to resolve.
    // Single-Member: they ARE the account's owner and main contact.
    // Multi-Member: they're only a starting point; NOT auto-marked as the
    // account's main contact — that's exactly what needsMemberSetup exists
    // to send staff back to confirm, alongside the rest of the roster.
    const linkResult = await linkContactToAccount(created.account_id, existingContactId, 'owner', !isMultiMember)
    if (!linkResult.success) {
      return {
        success: true,
        data: { id: created.account_id },
        warning: `Account created, but linking the existing contact failed: ${linkResult.error}`,
      }
    }
    return { success: true, data: { id: created.account_id }, needsMemberSetup: isMultiMember }
  }

  const linkResult = await createAndLinkContactOp({
    account_id: created.account_id,
    first_name: parsedContact!.first_name,
    middle_name: parsedContact!.middle_name || null,
    last_name: parsedContact!.last_name,
    email: parsedContact!.email || null,
    address_line1: parsedContact!.address_line1 || null,
    address_city: parsedContact!.address_city || null,
    address_state: parsedContact!.address_state || null,
    address_zip: parsedContact!.address_zip || null,
    address_country: parsedContact!.address_country || null,
    role: 'owner',
    is_primary: true,
    actor,
  })
  if (!linkResult.success) {
    // The account itself was created successfully — don't hide that
    // behind an error toast. Surface the contact failure as a warning
    // so staff can add the contact by hand from the account page.
    return {
      success: true,
      data: { id: created.account_id },
      warning: `Account created, but adding the primary contact failed: ${linkResult.error}`,
    }
  }

  return { success: true, data: { id: created.account_id }, warning: linkResult.warning, needsMemberSetup: isMultiMember }
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
    // Write goes through updateDocument() which owns the action_log entry
    // (same contract as MCP sites) — so safeAction is called without its
    // `audit` config to avoid a duplicate log row. Client alerting
    // (notification + push + chat + "New" badge) is owned by updateDocument
    // too: it fires the idempotent new-document alert only on the actual
    // hidden→visible transition (lib/portal/document-alerts.ts), so a
    // re-show of an already-notified document never double-notifies.
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const actor = `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`

    const { updateDocument } = await import('@/lib/operations/document')
    const result = await updateDocument({
      id: documentId,
      patch: { portal_visible: visible },
      actor,
      summary: `Portal visibility ${visible ? 'enabled' : 'disabled'}`,
    })
    if (!result.success) throw new Error(result.error || 'Failed to update document visibility')
  })
}

export async function linkContactToAccount(
  accountId: string,
  contactId: string,
  role: string = 'owner',
  isPrimary: boolean = false,
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
      .insert({ account_id: accountId, contact_id: contactId, role, is_primary: isPrimary })

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
): Promise<ActionResult & { contactId?: string; warning?: string }> {
  const trimmed = fullName.trim()
  if (!trimmed) {
    return { success: false, error: 'Contact name is required' }
  }
  // This panel still takes one free-text field — split the same way the
  // form used to, unchanged for this surface (a single-word name is still
  // allowed here, unlike the New Account dialog's dedicated first/middle/
  // last inputs, which require both — see createAccount above).
  const parts = trimmed.split(/\s+/)
  const firstName = parts[0] || ''
  const lastName = parts.slice(1).join(' ')

  const actor = await getDashboardActor()
  const result = await createAndLinkContactOp({
    account_id: accountId,
    first_name: firstName,
    last_name: lastName,
    email,
    role,
    actor,
  })

  if (!result.success) {
    return { success: false, error: result.error || 'Failed to add contact' }
  }

  revalidatePath(`/accounts/${accountId}`)
  return { success: true, contactId: result.contact_id, warning: result.warning }
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

// ── DBA Creation ───────────────────────────────────────────────────
// Creates a DBA service delivery + dba_details row from the account detail
// page. The SD is the parent (pipeline lives there: Data Collection → ... →
// Registered → Renewal Due); dba_details carries the registration-specific
// fields (name, jurisdiction, registration_number, etc.) keyed by delivery_id.
// Service name on the SD is set to the DBA name so it surfaces in the
// stepper and account-wide service lists without an extra join.

export interface CreateDBAInput {
  dba_name: string
  jurisdiction: string
  filed_date?: string | null
  registration_number?: string | null
  renewal_date?: string | null
  renewal_period?: string | null
  filing_fee?: number | null
  notes?: string | null
}

export async function createDBA(
  accountId: string,
  input: CreateDBAInput,
): Promise<ActionResult<{ id: string }>> {
  const dba_name = input.dba_name?.trim()
  const jurisdiction = input.jurisdiction?.trim()
  const notes = input.notes?.trim() || null
  const filed_date = input.filed_date?.trim() || null
  const registration_number = input.registration_number?.trim() || null
  const renewal_date = input.renewal_date?.trim() || null
  const renewal_period = input.renewal_period?.trim() || null
  const filing_fee =
    input.filing_fee == null || Number.isNaN(input.filing_fee) ? null : Number(input.filing_fee)

  if (!dba_name) return { success: false, error: 'DBA name is required' }
  if (!jurisdiction) return { success: false, error: 'Jurisdiction is required' }

  return safeAction(async () => {
    const sd = await createSD({
      service_type: 'DBA',
      service_name: dba_name,
      account_id: accountId,
      notes,
    })

    // dba_details is not yet in the generated DB types — cast once here so the
    // insert call typechecks. Drop the cast when types are regenerated.
    const untyped = supabaseAdmin as unknown as {
      from: (table: string) => {
        insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>
      }
    }
    const { error: detailsErr } = await untyped
      .from('dba_details')
      .insert({
        delivery_id: sd.id,
        dba_name,
        jurisdiction,
        filed_date,
        registration_number,
        renewal_date,
        renewal_period,
        filing_fee,
        notes,
      })

    if (detailsErr) {
      throw new Error(`SD created (${sd.id}) but dba_details insert failed: ${detailsErr.message}`)
    }

    revalidatePath(`/accounts/${accountId}`)
    return { id: sd.id }
  }, {
    action_type: 'create',
    table_name: 'service_deliveries',
    account_id: accountId,
    summary: `Created DBA: ${dba_name} (${jurisdiction})`,
    details: { dba_name, jurisdiction, filed_date, registration_number, renewal_date, renewal_period, filing_fee, notes },
  })
}

// ── DBA Update ─────────────────────────────────────────────────────
// Inline-edit support for dba_details rows on the account detail page.
// Each call updates a single row identified by its primary key (id). The
// caller passes the row's last-known updated_at for optimistic locking;
// if the row was modified since (e.g. by another machine), we retry once
// with supabaseAdmin so the user-visible flow still succeeds — mirrors
// updateWithLock semantics for typed tables.

export type UpdateDBADetailsInput = Partial<{
  dba_name: string | null
  jurisdiction: string | null
  filed_date: string | null
  registration_number: string | null
  renewal_date: string | null
  renewal_period: string | null
  filing_fee: number | null
  notes: string | null
}>

const DBA_ALLOWED_FIELDS = new Set<keyof UpdateDBADetailsInput>([
  'dba_name', 'jurisdiction', 'filed_date', 'registration_number',
  'renewal_date', 'renewal_period', 'filing_fee', 'notes',
])

export async function updateDBADetails(
  dbaId: string,
  updates: UpdateDBADetailsInput,
  updatedAt: string,
): Promise<ActionResult<{ updated_at: string }>> {
  // Whitelist: never trust client-supplied keys directly.
  const sanitized: Record<string, unknown> = {}
  for (const key of Object.keys(updates) as Array<keyof UpdateDBADetailsInput>) {
    if (!DBA_ALLOWED_FIELDS.has(key)) continue
    const raw = updates[key]
    if (raw == null) {
      sanitized[key] = null
      continue
    }
    if (key === 'filing_fee') {
      const n = Number(raw)
      sanitized[key] = Number.isFinite(n) ? n : null
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim()
      sanitized[key] = trimmed === '' ? null : trimmed
    } else {
      sanitized[key] = raw
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return { success: false, error: 'No editable fields supplied' }
  }

  // Required fields must remain non-empty if explicitly cleared.
  if (sanitized.dba_name === null) {
    return { success: false, error: 'DBA name is required' }
  }
  if (sanitized.jurisdiction === null) {
    return { success: false, error: 'Jurisdiction is required' }
  }

  return safeAction(async () => {
    const now = new Date().toISOString()
    const patch = { ...sanitized, updated_at: now }

    // dba_details is not yet in the generated DB types — cast for both the
    // optimistic-locked attempt and the admin retry.
    const untyped = supabaseAdmin as unknown as {
      from: (table: string) => {
        update: (row: Record<string, unknown>) => {
          eq: (col: string, val: string) => {
            eq: (col: string, val: string) => {
              select: (sel: string) => Promise<{ data: Array<{ id: string; updated_at: string }> | null; error: { message: string } | null }>
            }
            select: (sel: string) => Promise<{ data: Array<{ id: string; updated_at: string }> | null; error: { message: string } | null }>
          }
        }
      }
    }

    const { data, error } = await untyped
      .from('dba_details')
      .update(patch)
      .eq('id', dbaId)
      .eq('updated_at', updatedAt)
      .select('id, updated_at')

    if (error) throw new Error(error.message)

    let resolvedUpdatedAt = data?.[0]?.updated_at ?? null
    if (!resolvedUpdatedAt) {
      // Stale updated_at — retry once with admin (bypasses cache).
      const retryNow = new Date().toISOString()
      const retryPatch = { ...sanitized, updated_at: retryNow }
      const retryRes = await untyped
        .from('dba_details')
        .update(retryPatch)
        .eq('id', dbaId)
        .select('id, updated_at')
      if (retryRes.error) throw new Error(retryRes.error.message)
      if (!retryRes.data || retryRes.data.length === 0) {
        throw new Error('DBA row not found')
      }
      resolvedUpdatedAt = retryRes.data[0].updated_at
    }

    // Find the parent account_id so revalidatePath fires on the right route.
    const adminClient = supabaseAdmin as unknown as {
      from: (table: string) => {
        select: (sel: string) => {
          eq: (col: string, val: string) => {
            single: () => Promise<{ data: { delivery_id: string } | null }>
          }
        }
      }
    }
    const { data: ddRow } = await adminClient
      .from('dba_details')
      .select('delivery_id')
      .eq('id', dbaId)
      .single()

    if (ddRow?.delivery_id) {
      const { data: sd } = await supabaseAdmin
        .from('service_deliveries')
        .select('account_id')
        .eq('id', ddRow.delivery_id)
        .single()
      if (sd?.account_id) revalidatePath(`/accounts/${sd.account_id}`)
    }

    return { updated_at: resolvedUpdatedAt }
  }, {
    action_type: 'update',
    table_name: 'dba_details',
    record_id: dbaId,
    summary: `DBA detail fields updated: ${Object.keys(sanitized).join(', ')}`,
    details: sanitized,
  })
}
