import { supabaseAdmin } from '@/lib/supabase-admin'
import type { PortalAccount, PortalService } from '@/lib/types'

/**
 * Portal data queries. All use supabaseAdmin (service role, bypasses RLS)
 * with manual account_id filtering. This is intentional — existing RLS policies
 * are permissive (allow all authenticated). Portal isolation is enforced here.
 */

export async function getPortalAccounts(contactId: string): Promise<PortalAccount[]> {
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id, role')
    .eq('contact_id', contactId)

  if (!links || links.length === 0) return []

  const accountIds = links.map(l => l.account_id)
  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, account_type, portal_tier')
    .in('id', accountIds)
    // Include Active + Suspended (Suspended accounts show a banner + limited access).
    // Cancelled/Closed/Delinquent/Pending Formation are hidden from the portal.
    .in('status', ['Active', 'Suspended'])
    .order('company_name')

  return (accounts ?? []) as PortalAccount[]
}

export async function getPortalAccountDetail(accountId: string) {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, registered_agent_provider, registered_agent_address, ra_renewal_date, filing_id, invoice_logo_url, bank_details, payment_gateway, payment_link')
    .eq('id', accountId)
    .single()

  return data
}

export async function getPortalMembers(accountId: string) {
  const { data } = await supabaseAdmin
    .from('account_contacts')
    .select('role, ownership_pct, contacts(first_name, last_name, email, phone)')
    .eq('account_id', accountId)

  return (data ?? []).map(d => {
    const c = d.contacts as unknown as { first_name: string; last_name: string; email: string | null; phone: string | null } | null
    return {
      role: d.role,
      ownership_pct: d.ownership_pct,
      first_name: c?.first_name ?? '',
      last_name: c?.last_name ?? '',
      email: c?.email ?? null,
      phone: c?.phone ?? null,
    }
  })
}

export async function getPortalServices(accountId: string): Promise<PortalService[]> {
  // Primary source: service_deliveries (new table, account-linked)
  const { data: deliveries } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, service_type, stage, status, start_date, updated_at')
    .eq('account_id', accountId)
    .in('status', ['active', 'completed'])
    .order('updated_at', { ascending: false })

  if ((deliveries ?? []).length > 0) {
    return (deliveries ?? []).map(sd => ({
      id: sd.id,
      service_name: sd.service_name ?? sd.service_type ?? 'Service',
      service_type: sd.service_type ?? '',
      status: sd.status === 'active' ? 'In Progress' : 'Completed',
      current_step: null,
      total_steps: null,
      blocked_waiting_external: false,
      blocked_reason: null,
      start_date: sd.start_date,
      current_stage: sd.stage ?? null,
    })) as PortalService[]
  }

  // Fallback: legacy services table (for older accounts not yet migrated to service_deliveries)
  const { data } = await supabaseAdmin
    .from('services')
    .select('id, service_name, service_type, status, current_step, total_steps, blocked_waiting_external, blocked_reason, start_date')
    .eq('account_id', accountId)
    .in('status', ['Not Started', 'In Progress', 'Waiting Client', 'Waiting Third Party', 'Completed'])
    .order('updated_at', { ascending: false })

  return (data ?? []).map(s => ({
    ...s,
    current_stage: null,
  })) as PortalService[]
}

export async function getPortalServicesByContact(contactId: string): Promise<PortalService[]> {
  // For contact-only clients (ITIN, no LLC), query service_deliveries directly by contact_id
  const { data } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, service_type, stage, status, assigned_to, start_date, updated_at')
    .eq('contact_id', contactId)
    .in('status', ['active', 'completed'])
    .order('updated_at', { ascending: false })

  return (data ?? []).map(sd => ({
    id: sd.id,
    service_name: sd.service_name ?? sd.service_type ?? 'Service',
    service_type: sd.service_type ?? '',
    status: sd.status === 'active' ? 'In Progress' : 'Completed',
    current_step: null,
    total_steps: null,
    blocked_waiting_external: false,
    blocked_reason: null,
    start_date: sd.start_date,
    current_stage: sd.stage,
  })) as PortalService[]
}

export async function getPortalDeadlines(accountId: string) {
  const sixtyDaysLater = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0]

  const { data } = await supabaseAdmin
    .from('deadlines')
    .select('id, deadline_type, due_date, status, notes')
    .eq('account_id', accountId)
    .in('status', ['Pending', 'Overdue'])
    .lte('due_date', sixtyDaysLater)
    .order('due_date', { ascending: true })
    .limit(10)

  return data ?? []
}

export async function getPortalPayments(accountId: string) {
  const { data } = await supabaseAdmin
    .from('payments')
    .select('id, description, amount, amount_currency, period, year, due_date, paid_date, status, installment, invoice_number, invoice_status')
    .eq('account_id', accountId)
    .order('due_date', { ascending: false })
    .limit(20)

  return data ?? []
}

/**
 * Get client expenses (incoming invoices: TD billing + third-party uploads).
 * Used in the Expenses tab of the portal invoices page.
 */
export async function getPortalExpenses(accountId: string) {
  const { data } = await supabaseAdmin
    .from('client_expenses')
    .select('id, vendor_name, invoice_number, internal_ref, description, currency, total, subtotal, tax_amount, issue_date, due_date, paid_date, status, source, category, attachment_url, attachment_name, td_payment_id, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(100)

  return data ?? []
}

/**
 * Get invoice archive documents (PDFs of both sales and expense invoices).
 * Organized by year/month for display in the Documents tab.
 */
export async function getInvoiceArchive(accountId: string) {
  const { data } = await supabaseAdmin
    .from('client_invoice_documents')
    .select('id, direction, invoice_number, counterparty_name, amount, currency, issue_date, file_url, file_name, year, month, sales_invoice_id, expense_id')
    .eq('account_id', accountId)
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .order('issue_date', { ascending: false })
    .limit(500)

  return data ?? []
}

/**
 * Get active service_deliveries for this account to drive portal nav visibility.
 * Returns service names so the sidebar can show/hide sections.
 */
export async function getPortalActiveServices(accountId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('service_deliveries')
    .select('service_name')
    .eq('account_id', accountId)
    .in('stage', ['Active', 'Intake', 'Setup', 'Processing', 'Review'])

  return (data ?? []).map(d => d.service_name)
}

/**
 * Nav visibility flags based on actual data.
 * Each flag tells the sidebar whether to show a nav item.
 */
export interface PortalNavVisibility {
  services: boolean       // has any services or SDs
  billing: boolean        // has invoices from TD LLC
  invoices: boolean       // has client invoicing feature (client_invoices or client_customers)
  taxDocuments: boolean   // has tax-related SD or tax return
  deadlines: boolean      // has any pending/overdue deadlines
  documents: boolean      // always true (every client can upload docs)
  customers: boolean      // same as invoices
  pendingSignatures: boolean  // has unsigned OA or Lease agreements
  documentGenerator: boolean  // can generate distribution resolutions and tax statements
}

export async function getPortalNavVisibility(accountId: string): Promise<PortalNavVisibility> {
  // Run all checks in parallel
  const [
    serviceDeliveries,
    billingCount,
    deadlineCount,
    taxReturnCount,
    unsignedDocCount,
  ] = await Promise.all([
    // Active SDs
    supabaseAdmin
      .from('service_deliveries')
      .select('service_name', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .then(r => ({
        count: r.count ?? 0,
        names: [] as string[],
      })),
    // TD LLC invoices sent to client
    supabaseAdmin
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .not('invoice_status', 'is', null)
      .then(r => r.count ?? 0),
    // Pending deadlines
    supabaseAdmin
      .from('deadlines')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .in('status', ['Pending', 'Overdue'])
      .then(r => r.count ?? 0),
    // Tax returns (need company_name lookup)
    supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', accountId)
      .single()
      .then(async ({ data: acct }) => {
        if (!acct?.company_name) return 0
        const { count } = await supabaseAdmin
          .from('tax_returns')
          .select('id', { count: 'exact', head: true })
          .eq('company_name', acct.company_name)
        return count ?? 0
      }),
    // Unsigned OA, Lease, or SS-4 agreements
    Promise.all([
      supabaseAdmin
        .from('oa_agreements')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'signed'),
      supabaseAdmin
        .from('lease_agreements')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'signed'),
      supabaseAdmin
        .from('ss4_applications')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .in('status', ['awaiting_signature', 'draft']),
    ]).then(([oa, lease, ss4]) => (oa.count ?? 0) + (lease.count ?? 0) + (ss4.count ?? 0)),
  ])

  // Also check if any SD is tax-related
  const { data: taxSDs } = await supabaseAdmin
    .from('service_deliveries')
    .select('service_name')
    .eq('account_id', accountId)
    .ilike('service_name', '%tax%')
    .limit(1)

  const hasTaxSD = (taxSDs ?? []).length > 0

  return {
    services: serviceDeliveries.count > 0,
    billing: billingCount > 0,
    invoices: true,       // always visible — tier-config gates access (active/full only)
    taxDocuments: hasTaxSD || taxReturnCount > 0,
    deadlines: deadlineCount > 0,
    documents: true,      // always available
    customers: true,      // always visible — tier-config gates access (active/full only)
    pendingSignatures: unsignedDocCount > 0,
    documentGenerator: true, // always visible — tier-config gates access (active/full only)
  }
}

/**
 * Get the portal tier for an account.
 * Returns 'lead', 'onboarding', 'active', or 'full'.
 */
export async function getPortalTier(accountId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('portal_tier')
    .eq('id', accountId)
    .single()

  return data?.portal_tier || 'active'
}

/**
 * Get portal tier from CONTACT (source of truth).
 * contacts.portal_tier tracks the person's journey, not the company's.
 * Falls back to 'lead' if not set.
 */
export async function getPortalTierByContact(contactId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('portal_tier')
    .eq('id', contactId)
    .single()

  return data?.portal_tier || 'lead'
}

export async function getPortalRoleByContact(contactId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('portal_role')
    .eq('id', contactId)
    .single()

  return data?.portal_role || null
}

/**
 * Nav visibility for contacts WITHOUT any account (e.g., ITIN-only clients).
 * Only contact-level features are visible.
 */
export function getContactOnlyNavVisibility(): PortalNavVisibility {
  return {
    services: true,
    billing: false,
    invoices: false,
    taxDocuments: false,
    deadlines: false,
    documents: true,
    customers: false,
    pendingSignatures: false,
    documentGenerator: false,
  }
}

/**
 * Count unread admin messages for a client.
 * Used for the chat badge in the sidebar.
 */
export async function getUnreadChatCount(accountId: string | null, contactId: string): Promise<number> {
  let query = supabaseAdmin
    .from('portal_messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_type', 'admin')
    .is('read_at', null)

  if (accountId) {
    query = query.eq('account_id', accountId)
  } else {
    query = query.eq('contact_id', contactId).is('account_id', null)
  }

  const { count } = await query
  return count ?? 0
}

export async function getPortalTaxReturns(accountId: string) {
  // Tax returns are matched by company_name, not account_id
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', accountId)
    .single()

  if (!account?.company_name) return []

  const { data } = await supabaseAdmin
    .from('tax_returns')
    .select('id, tax_year, return_type, status, deadline, extension_filed, extension_deadline, data_received, sent_to_india')
    .eq('company_name', account.company_name)
    .order('tax_year', { ascending: false })
    .limit(5)

  return data ?? []
}

// ─── Action Items ──────────────────────────────────────

export interface ActionItem {
  type: 'form' | 'invoice' | 'signature' | 'wizard'
  title: string
  titleIt: string
  description: string
  descriptionIt: string
  href: string
  priority: 'red' | 'orange' | 'blue'
  createdAt: string
}

export interface ActionItemsResult {
  items: ActionItem[]
  counts: { red: number; orange: number; blue: number; total: number }
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000)
}

/**
 * Get all pending action items for a client.
 * Aggregates: unfilled wizard forms, unpaid invoices, unsigned documents.
 */
export async function getPortalActionItems(
  accountId: string,
  contactId?: string
): Promise<ActionItemsResult> {
  const today = new Date().toISOString().split('T')[0]

  // Look up company_name for tax_returns query (matched by name, not account_id)
  const { data: acctForTax } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', accountId)
    .single()

  const [wizardRes, invoiceRes, oaRes, leaseRes, ss4Res, msaRes, taxRes, sigReqRes] = await Promise.all([
    // 1. In-progress wizard forms
    supabaseAdmin
      .from('wizard_progress')
      .select('id, wizard_type, created_at, updated_at')
      .eq('status', 'in_progress')
      .or(
        accountId
          ? `account_id.eq.${accountId}${contactId ? `,contact_id.eq.${contactId}` : ''}`
          : contactId ? `contact_id.eq.${contactId}` : 'id.is.null'
      )
      .limit(10),

    // 2. Unpaid invoices (Sent or Overdue)
    supabaseAdmin
      .from('payments')
      .select('id, invoice_number, total, amount_currency, due_date, invoice_status, created_at')
      .eq('account_id', accountId)
      .in('invoice_status', ['Sent', 'Overdue'])
      .order('due_date', { ascending: true })
      .limit(10),

    // 3. Unsigned OA (includes partially_signed for MMLLC)
    supabaseAdmin
      .from('oa_agreements')
      .select('id, token, status, created_at, total_signers, signed_count, entity_type')
      .eq('account_id', accountId)
      .in('status', ['sent', 'viewed', 'awaiting_signature', 'partially_signed'])
      .limit(5),

    // 4. Unsigned Lease
    supabaseAdmin
      .from('lease_agreements')
      .select('id, token, status, created_at')
      .eq('account_id', accountId)
      .in('status', ['sent', 'viewed', 'awaiting_signature'])
      .limit(5),

    // 5. Unsigned SS-4
    supabaseAdmin
      .from('ss4_applications')
      .select('id, token, status, created_at')
      .eq('account_id', accountId)
      .in('status', ['sent', 'viewed', 'awaiting_signature'])
      .limit(5),

    // 6. Unsigned Annual MSA (renewal offers not yet signed)
    supabaseAdmin
      .from('offers')
      .select('id, token, status, created_at')
      .eq('account_id', accountId)
      .eq('contract_type', 'renewal')
      .in('status', ['draft', 'sent', 'viewed'])
      .limit(5),

    // 7. Pending tax returns (data not yet collected from client)
    acctForTax?.company_name
      ? supabaseAdmin
          .from('tax_returns')
          .select('id, tax_year, return_type, created_at')
          .eq('company_name', acctForTax.company_name)
          .eq('data_received', false)
          .limit(5)
      : Promise.resolve({ data: [] }),

    // 8. Unsigned generic signature requests (Form 8879, etc.)
    supabaseAdmin
      .from('signature_requests')
      .select('id, token, access_code, document_name, status, created_at')
      .eq('account_id', accountId)
      .in('status', ['sent', 'viewed'])
      .limit(10),
  ])

  const items: ActionItem[] = []

  // ── Wizard forms ──
  for (const w of wizardRes.data ?? []) {
    const age = daysSince(w.created_at)
    const priority: ActionItem['priority'] = age > 7 ? 'red' : age > 3 ? 'orange' : 'blue'
    const typeLabel = w.wizard_type === 'formation' ? 'Formation' : w.wizard_type === 'onboarding' ? 'Onboarding' : w.wizard_type
    items.push({
      type: 'form',
      title: `Complete ${typeLabel} Form`,
      titleIt: `Completa il modulo di ${typeLabel === 'Formation' ? 'Costituzione' : typeLabel === 'Onboarding' ? 'Onboarding' : typeLabel}`,
      description: 'Your data collection form is in progress. Please complete it.',
      descriptionIt: 'Il tuo modulo di raccolta dati è in corso. Completalo.',
      href: '/portal/wizard',
      priority,
      createdAt: w.created_at,
    })
  }

  // ── Pending tax returns (assigned but client hasn't submitted data yet) ──
  for (const tr of (taxRes as { data: Array<{ id: string; tax_year: number; return_type: string; created_at: string }> | null }).data ?? []) {
    // Check if there's already a wizard_progress for tax (avoids duplicate with wizard item above)
    const alreadyHasWizard = (wizardRes.data ?? []).some(
      w => w.wizard_type === 'tax' || w.wizard_type === 'tax_return'
    )
    if (alreadyHasWizard) continue

    const age = daysSince(tr.created_at)
    const priority: ActionItem['priority'] = age > 14 ? 'red' : age > 7 ? 'orange' : 'blue'
    items.push({
      type: 'wizard',
      title: `Complete Tax Information — ${tr.tax_year}`,
      titleIt: `Completa le Informazioni Fiscali — ${tr.tax_year}`,
      description: `Your ${tr.return_type || 'tax'} return for ${tr.tax_year} requires your financial data. Please complete the tax wizard.`,
      descriptionIt: `La tua dichiarazione ${tr.return_type || 'fiscale'} per il ${tr.tax_year} richiede i tuoi dati finanziari. Completa il wizard fiscale.`,
      href: '/portal/wizard',
      priority,
      createdAt: tr.created_at,
    })
  }

  // ── Unpaid invoices ──
  for (const inv of invoiceRes.data ?? []) {
    const isOverdue = inv.invoice_status === 'Overdue' || (inv.due_date && inv.due_date < today)
    const dueSoon = inv.due_date ? daysUntil(inv.due_date) <= 7 : false
    const priority: ActionItem['priority'] = isOverdue ? 'red' : dueSoon ? 'orange' : 'blue'
    const amount = `${inv.amount_currency || 'USD'} ${Number(inv.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
    items.push({
      type: 'invoice',
      title: `Pay Invoice ${inv.invoice_number || ''}`,
      titleIt: `Paga Fattura ${inv.invoice_number || ''}`,
      description: `${amount} — ${isOverdue ? 'Overdue' : inv.due_date ? `Due ${inv.due_date}` : 'Payment pending'}`,
      descriptionIt: `${amount} — ${isOverdue ? 'Scaduta' : inv.due_date ? `Scadenza ${inv.due_date}` : 'Pagamento in sospeso'}`,
      href: '/portal/invoices?tab=expenses',
      priority,
      createdAt: inv.created_at,
    })
  }

  // ── Unsigned documents ──
  // ── Unsigned documents (non-OA) ──
  const signDocsNonOA = [
    ...(msaRes.data ?? []).map(d => ({ ...d, docType: 'Annual Service Agreement', docTypeIt: 'Contratto di Servizio Annuale' })),
    ...(leaseRes.data ?? []).map(d => ({ ...d, docType: 'Lease Agreement', docTypeIt: 'Contratto di Locazione' })),
    ...(ss4Res.data ?? []).map(d => ({ ...d, docType: 'SS-4 (EIN Application)', docTypeIt: 'SS-4 (Richiesta EIN)' })),
  ]

  for (const doc of signDocsNonOA) {
    const age = daysSince(doc.created_at)
    const priority: ActionItem['priority'] = age > 14 ? 'red' : age > 7 ? 'orange' : 'blue'
    items.push({
      type: 'signature',
      title: `Sign ${doc.docType}`,
      titleIt: `Firma ${doc.docTypeIt}`,
      description: 'Document awaiting your signature.',
      descriptionIt: 'Documento in attesa della tua firma.',
      href: '/portal/sign',
      priority,
      createdAt: doc.created_at,
    })
  }

  // ── Unsigned OA (per-member aware for MMLLC) ──
  for (const oaDoc of oaRes.data ?? []) {
    const oaAny = oaDoc as typeof oaDoc & { total_signers?: number; signed_count?: number; entity_type?: string }
    const isMultiSigner = (oaAny.entity_type === 'MMLLC') && (oaAny.total_signers || 1) > 1

    if (isMultiSigner && contactId) {
      // Check if THIS member has already signed
      const { data: memberSig } = await supabaseAdmin
        .from('oa_signatures')
        .select('status')
        .eq('oa_id', oaDoc.id)
        .eq('contact_id', contactId)
        .maybeSingle()

      // If this member already signed, don't show the action item
      if (memberSig?.status === 'signed') continue
    }

    const age = daysSince(oaDoc.created_at)
    const priority: ActionItem['priority'] = age > 14 ? 'red' : age > 7 ? 'orange' : 'blue'
    items.push({
      type: 'signature',
      title: 'Sign Operating Agreement',
      titleIt: 'Firma Accordo Operativo',
      description: isMultiSigner
        ? `${oaAny.signed_count || 0} of ${oaAny.total_signers} members have signed. Your signature is needed.`
        : 'Document awaiting your signature.',
      descriptionIt: isMultiSigner
        ? `${oaAny.signed_count || 0} di ${oaAny.total_signers} membri hanno firmato. La tua firma è necessaria.`
        : 'Documento in attesa della tua firma.',
      href: '/portal/sign',
      priority,
      createdAt: oaDoc.created_at,
    })
  }

  // ── Generic signature requests (Form 8879, etc.) ──
  for (const sig of (sigReqRes as { data: Array<{ id: string; token: string; access_code: string; document_name: string; status: string; created_at: string }> | null }).data ?? []) {
    const age = daysSince(sig.created_at)
    const priority: ActionItem['priority'] = age > 14 ? 'red' : age > 7 ? 'orange' : 'blue'
    items.push({
      type: 'signature',
      title: `Sign ${sig.document_name}`,
      titleIt: `Firma ${sig.document_name}`,
      description: 'Document awaiting your signature.',
      descriptionIt: 'Documento in attesa della tua firma.',
      href: `/portal/sign/document?token=${sig.token}`,
      priority,
      createdAt: sig.created_at,
    })
  }

  // Sort: red → orange → blue, then by date (oldest first)
  const priorityOrder = { red: 0, orange: 1, blue: 2 }
  items.sort((a, b) => {
    const po = priorityOrder[a.priority] - priorityOrder[b.priority]
    if (po !== 0) return po
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })

  const counts = {
    red: items.filter(i => i.priority === 'red').length,
    orange: items.filter(i => i.priority === 'orange').length,
    blue: items.filter(i => i.priority === 'blue').length,
    total: items.length,
  }

  return { items, counts }
}

/**
 * Get the company communication email for an account.
 *
 * Resolution order (deterministic):
 * 1. accounts.communication_email — if set, use it
 * 2. Primary contact fallback:
 *    a. Contacts with role containing 'owner' (case-insensitive)
 *    b. Among owners: highest ownership_pct, then earliest contacts.created_at
 *    c. If no owners: same logic across all linked contacts
 *
 * Returns null if no contacts are linked.
 */
export async function getCompanyEmail(accountId: string): Promise<string | null> {
  // Step 1: Check communication_email on the account
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('communication_email')
    .eq('id', accountId)
    .single()

  if (account?.communication_email) {
    return account.communication_email
  }

  // Step 2: Deterministic primary contact fallback
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('role, ownership_pct, contacts(email, created_at)')
    .eq('account_id', accountId)

  if (!links || links.length === 0) return null

  type ContactLink = {
    role: string | null
    ownership_pct: number | null
    contacts: { email: string | null; created_at: string | null } | null
  }

  const rows = (links as unknown as ContactLink[]).filter(l => l.contacts?.email)

  if (rows.length === 0) return null

  // Sort: owners first, then by ownership_pct desc, then by created_at asc
  const sorted = [...rows].sort((a, b) => {
    const aIsOwner = a.role?.toLowerCase().includes('owner') ? 1 : 0
    const bIsOwner = b.role?.toLowerCase().includes('owner') ? 1 : 0
    if (bIsOwner !== aIsOwner) return bIsOwner - aIsOwner

    const aPct = a.ownership_pct ?? 0
    const bPct = b.ownership_pct ?? 0
    if (bPct !== aPct) return bPct - aPct

    const aDate = a.contacts?.created_at ?? '9999'
    const bDate = b.contacts?.created_at ?? '9999'
    return aDate.localeCompare(bDate)
  })

  return sorted[0].contacts!.email
}
