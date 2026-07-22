import { supabaseAdmin } from '@/lib/supabase-admin'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { resolveMailingAddress } from '@/lib/addresses'
import { mayIncludePersonalNull } from '@/lib/portal/chat-scope'
import { isClientVisiblePayment, filterClientVisibleExpenseMirrors } from '@/lib/portal/payment-visibility'
import type { PortalAccount, PortalService } from '@/lib/types'
import type { FlowStageRow, FlowStep } from '@/lib/flows/flow-progress'
import type { FormationStageRow } from '@/lib/portal/formation-progress'
import { normalizeStageHistory } from '@/lib/stage-history-helpers'
import { resolveTaxWizardEligibility } from '@/lib/tax/wizard-eligibility'
import { completeWizardFormTitle, startWizardFormTitle } from '@/lib/portal/wizard-labels'

/**
 * Portal data queries. All use supabaseAdmin (service role, bypasses RLS)
 * with manual account_id filtering. This is intentional — existing RLS policies
 * are permissive (allow all authenticated). Portal isolation is enforced here.
 */

export async function getPortalAccounts(contactId: string): Promise<PortalAccount[]> {
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id, role, is_primary')
    .eq('contact_id', contactId)

  if (!links || links.length === 0) return []

  const accountIds = links.map(l => l.account_id)
  const primaryIds = new Set(links.filter(l => l.is_primary).map(l => l.account_id))

  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, account_type, portal_tier')
    .in('id', accountIds)
    // Include Active + Suspended (Suspended accounts show a banner + limited access).
    // Cancelled/Closed/Delinquent/Pending Formation are hidden from the portal.
    .in('status', ['Active', 'Suspended'])
    .order('company_name')

  // Primary account first, then alphabetical
  const sorted = (accounts ?? []).sort((a, b) => {
    const ap = primaryIds.has(a.id) ? 0 : 1
    const bp = primaryIds.has(b.id) ? 0 : 1
    if (ap !== bp) return ap - bp
    return a.company_name.localeCompare(b.company_name)
  })

  return sorted as PortalAccount[]
}

/**
 * A switchable entity in the per-company chat chooser (2026-06-24).
 *  - 'company'  → a real account (its shared thread).
 *  - 'formation'→ an in-progress formation (no account yet) → personal-scope view.
 *  - 'personal' → a synthetic "Personal / General" home for the contact's
 *                 untagged messages, added ONLY when no sole-owned company can
 *                 host them and there's no formation already giving a personal view.
 */
export interface PortalChatEntity {
  /** accountId | InProgressFormation.id | 'personal' */
  id: string
  kind: 'company' | 'formation' | 'personal'
  label: string
  /** Real account id for company entities; null for formation/personal. */
  accountId: string | null
  /** True when >1 contact is linked (shared MMLLC) — drives the send-popup warning. */
  isShared: boolean
  /** Sole-owned company → its view may include the contact's personal NULLs. */
  includePersonalNull: boolean
}

/**
 * Build the chat entity list for a contact: their companies (with the
 * sole-owned / shared classification that governs personal-NULL visibility),
 * in-progress formations, and a Personal home when needed. The privacy
 * classification uses the SAME leak-proof predicate as the chat API
 * (mayIncludePersonalNull) — sole linked contact, never the free-text role.
 */
export async function getChatEntities(contactId: string): Promise<PortalChatEntity[]> {
  const accounts = await getPortalAccounts(contactId)
  const entities: PortalChatEntity[] = []
  let hasSoleOwned = false

  if (accounts.length > 0) {
    const ids = accounts.map(a => a.id)
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id, contact_id')
      .in('account_id', ids)
    const membersByAccount = new Map<string, string[]>()
    for (const l of links ?? []) {
      const arr = membersByAccount.get(l.account_id) ?? []
      arr.push(l.contact_id)
      membersByAccount.set(l.account_id, arr)
    }
    for (const a of accounts) {
      const members = membersByAccount.get(a.id) ?? []
      const includePersonalNull = mayIncludePersonalNull({
        linkedContactCount: members.length,
        viewerIsSoleLinkedContact: members.length === 1 && members[0] === contactId,
      })
      if (includePersonalNull) hasSoleOwned = true
      entities.push({
        id: a.id,
        kind: 'company',
        label: a.company_name,
        accountId: a.id,
        isShared: members.length > 1,
        includePersonalNull,
      })
    }
  }

  const formations = await getInProgressFormations(contactId)
  for (const f of formations) {
    entities.push({ id: f.id, kind: 'formation', label: f.label, accountId: null, isShared: false, includePersonalNull: false })
  }

  // Personal home for untagged messages — only when nothing else hosts them.
  if (!hasSoleOwned && formations.length === 0) {
    entities.push({ id: 'personal', kind: 'personal', label: 'Personal', accountId: null, isShared: false, includePersonalNull: false })
  }

  return entities
}

/**
 * Load a single account in PortalAccount shape (Active/Suspended only).
 * Used by the teammate-scoped portal layout (a teammate is bound to ONE account
 * and is not a contact, so getPortalAccounts(contactId) does not apply).
 */
export async function getPortalAccountById(accountId: string): Promise<PortalAccount | null> {
  if (!accountId) return null
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, account_type, portal_tier')
    .eq('id', accountId)
    .in('status', ['Active', 'Suspended'])
    .maybeSingle()
  return (data as PortalAccount) ?? null
}

/**
 * Finds the 'Pending Formation' account linked to a contact.
 * Used by the formation dashboard — these accounts are excluded from
 * getPortalAccounts (which only returns Active/Suspended) so we query separately.
 */
export async function getFormationAccount(contactId: string) {
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contactId)

  if (!links || links.length === 0) return null

  const accountIds = links.map(l => l.account_id)
  const { data } = await (supabaseAdmin as any)
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, filing_id, status, physical_address, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
    .in('id', accountIds)
    .eq('status', 'Pending Formation')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return data
  return { ...data, physical_address: resolveMailingAddress(data.mailing_address, data.physical_address) }
}

/**
 * Contact-scoped formation state for clients in the gap between offer-paid
 * and Articles-of-Organization arrival (Antonio's architectural model,
 * 2026-05-03/04). No company exists yet, so wizard/SS-4/OA/lease are queried
 * by contact_id instead of account_id. Returns null fields when nothing has
 * happened yet (e.g., before wizard submission).
 */
export async function getFormationContext(contactId: string) {
  const [wizardRes, ss4Res, oaRes, leaseRes] = await Promise.all([
    supabaseAdmin
      .from('wizard_progress')
      .select('id, status')
      .eq('contact_id', contactId)
      .eq('wizard_type', 'formation')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('ss4_applications')
      .select('id, status')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('oa_agreements')
      .select('id, status')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('lease_agreements')
      .select('id, status')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  return {
    wizard: wizardRes.data,
    ss4: ss4Res.data,
    oa: oaRes.data,
    lease: leaseRes.data,
  }
}

/**
 * Data for the client-facing Company Formation progress tracker: the formation
 * SD's current stage + the 8 Company Formation pipeline stages (client labels).
 * The tracker is driven entirely by this (SD stage + pipeline_stages), not by
 * separate signals. Resolves the SD by, in priority: explicit sdId → active SD
 * for accountId → contact-scoped (account_id NULL) active SD for contactId.
 * Returns null when there are no Company Formation pipeline stages.
 */
export async function getFormationTracker(opts: {
  sdId?: string | null
  contactId?: string | null
  accountId?: string | null
}): Promise<{ currentStage: string | null; stages: FormationStageRow[]; filedAt: string | null; faxedAt: string | null; ss4SignPending: boolean | null } | null> {
  // Resolve the formation SD's current stage, cascading through the locators in
  // priority order and stopping at the first hit (an account-scoped lookup falls
  // back to the contact-scoped SD for not-yet-materialized formations). We also
  // capture stage_entered_at + stage_history off the matched SD so we can derive
  // the filing date (see filedAt below).
  const SD_COLS = 'stage, stage_entered_at, stage_history, account_id'
  let sdRow: { stage: string | null; stage_entered_at: string | null; stage_history: unknown; account_id: string | null } | null = null
  if (opts.sdId) {
    const { data } = await supabaseAdmin
      .from('service_deliveries')
      .select(SD_COLS)
      .eq('id', opts.sdId)
      .maybeSingle()
    sdRow = (data as typeof sdRow) ?? null
  }
  if (sdRow == null && opts.accountId) {
    const { data } = await supabaseAdmin
      .from('service_deliveries')
      .select(SD_COLS)
      .eq('account_id', opts.accountId)
      .eq('service_type', 'Company Formation')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    sdRow = (data as typeof sdRow) ?? null
  }
  if (sdRow == null && opts.contactId) {
    const { data } = await supabaseAdmin
      .from('service_deliveries')
      .select(SD_COLS)
      .eq('contact_id', opts.contactId)
      .is('account_id', null)
      .eq('service_type', 'Company Formation')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    sdRow = (data as typeof sdRow) ?? null
  }

  const currentStage = (sdRow?.stage as string | null) ?? null

  // "Sign your SS-4" readiness — only meaningful while the SD sits at
  // "SS-4 Prepared". The stage flips when staff PREPARE the SS-4, but the
  // client can only sign once it's SENT (ss4_applications.status =
  // 'awaiting_signature'); a draft is still under staff review. Without this
  // gate the tracker glowed "Action required — sign your SS-4" while there was
  // nothing signable (Michele Cotti, 2026-07-02). null = unknown/not at that
  // stage → the tracker fails OPEN (keeps the glow) so a lookup hiccup never
  // hides a real action.
  let ss4SignPending: boolean | null = null
  if (currentStage === 'SS-4 Prepared' && sdRow?.account_id) {
    const { data: ss4Row, error: ss4Err } = await supabaseAdmin
      .from('ss4_applications')
      .select('status')
      .eq('account_id', sdRow.account_id)
      .maybeSingle()
    if (!ss4Err) ss4SignPending = ss4Row?.status === 'awaiting_signature'
  }

  // Filing date for the "Filed with State" step + the waiting banner. Prefer the
  // durable stage_history transition into "Filed with State" (survives advancing
  // past the stage); fall back to stage_entered_at only while the SD still sits
  // AT that stage; otherwise unknown (legacy SD with no recorded transition).
  const filedFromHistory =
    normalizeStageHistory(sdRow?.stage_history).find((e) => e.to_stage === 'Filed with State')?.advanced_at ?? null
  const filedAt =
    filedFromHistory ?? (currentStage === 'Filed with State' ? (sdRow?.stage_entered_at ?? null) : null)

  // Fax date: when the SD advanced to "SS-4 Sent to IRS" (same pattern as filedAt).
  const faxedFromHistory =
    normalizeStageHistory(sdRow?.stage_history).find((e) => e.to_stage === 'SS-4 Sent to IRS')?.advanced_at ?? null
  const faxedAt =
    faxedFromHistory ?? (currentStage === 'SS-4 Sent to IRS' ? (sdRow?.stage_entered_at ?? null) : null)

  const { data: stageRows } = await supabaseAdmin
    .from('pipeline_stages')
    .select('stage_name, stage_order, client_label, client_label_it')
    .eq('service_type', 'Company Formation')
    .order('stage_order', { ascending: true })

  if (!stageRows || stageRows.length === 0) return null
  return { currentStage, stages: stageRows as unknown as FormationStageRow[], filedAt, faxedAt, ss4SignPending }
}

export interface InProgressFormation {
  /** Synthetic switcher id — namespaced so it never collides with a real account id. */
  id: string
  /** The underlying Company Formation service-delivery id. */
  sdId: string
  /** Display name: chosen LLC name when the wizard picked one, else a generic label. */
  label: string
  /** Portal stage used for tier-gating when this entity is selected. */
  stage: 'formation'
  /**
   * The lead this new-company formation is anchored on. The formation wizard
   * scopes via ?lead=<leadId> (PR #75 / dev_task 21fd1f4a), so every CTA that
   * opens this formation's wizard MUST carry it — otherwise a returning client
   * who already owns an account falls through to that account's wizard. Null
   * only when the offer/lead linkage can't be resolved.
   */
  leadId: string | null
}

/**
 * In-progress formations for a contact — companies that have been paid for and
 * are being formed, but do NOT yet exist as an account (no Articles of
 * Organization yet, per Antonio's model — no placeholder account). These are
 * surfaced as switchable pseudo-entities in the portal so an existing client
 * (who already owns an active company) can switch to view a new company being
 * formed, each with its own status.
 *
 * Source of truth: the `Company Formation` service-delivery. Materialization
 * (`formation-materialize.ts`) sets `service_deliveries.account_id` when the
 * company becomes real, so `account_id IS NULL` is the clean "not yet a company"
 * signal AND the de-dup against materialized companies. Read-only.
 *
 * Known gap (documented): the brief pre-payment window (signed offer, no SD yet)
 * is not included — the formation SD is created at activation. That window is
 * short; the offer-based path can be added later if needed.
 */
/**
 * Pull the offer token out of a Company Formation SD's notes. activate-service
 * writes `Auto-created from offer <token>` (the manual-backfill path appends
 * extra text but keeps that prefix). Returns null when no token is present.
 * Pure — unit-tested in tests/unit/in-progress-formation-lead.test.ts.
 */
export function extractOfferTokenFromNotes(notes: string | null | undefined): string | null {
  if (typeof notes !== 'string') return null
  const m = notes.match(/from offer ([\w-]+)/i)
  return m ? m[1] : null
}

export async function getInProgressFormations(contactId: string): Promise<InProgressFormation[]> {
  const { data: sds } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, notes')
    .eq('contact_id', contactId)
    .eq('service_type', 'Company Formation')
    .is('account_id', null)
    .eq('status', 'active')

  if (!sds || sds.length === 0) return []

  // Resolve the lead each formation is anchored on. Formation offers for this
  // contact are linked either directly (offers.contact_id) or via the converted
  // lead (offers.lead_id -> leads.converted_to_contact_id = contactId). The SD's
  // notes carry "...from offer <token>" (written by activate-service), which
  // disambiguates which offer -> lead maps to which SD when there are several
  // in-progress formations. Single-formation contacts fall back to their one
  // formation offer's lead even if the notes token can't be matched.
  const { data: convertedLeads } = await supabaseAdmin
    .from('leads')
    .select('id')
    .eq('converted_to_contact_id', contactId)
  const convertedLeadIds = (convertedLeads ?? []).map(l => l.id)

  const offerOr = [`contact_id.eq.${contactId}`]
  if (convertedLeadIds.length > 0) offerOr.push(`lead_id.in.(${convertedLeadIds.join(',')})`)
  const { data: formationOffers } = await supabaseAdmin
    .from('offers')
    .select('token, lead_id, created_at')
    .eq('contract_type', 'formation')
    .or(offerOr.join(','))
    .order('created_at', { ascending: false })

  const tokenToLead = new Map<string, string>()
  for (const o of formationOffers ?? []) {
    if (o.token && o.lead_id) tokenToLead.set(o.token, o.lead_id)
  }
  const soleFormationLeadId =
    (formationOffers ?? []).filter(o => o.lead_id).length > 0
      ? ((formationOffers ?? []).find(o => o.lead_id)?.lead_id ?? null)
      : null

  function resolveLeadId(notes: string | null): string | null {
    const token = extractOfferTokenFromNotes(notes)
    if (token && tokenToLead.has(token)) return tokenToLead.get(token) ?? null
    // Fallback only when there is exactly one in-progress formation, so we
    // never misattribute a lead to the wrong company.
    return sds.length === 1 ? soleFormationLeadId : null
  }

  // Chosen LLC name from the formation wizard, when submitted. Applied only when
  // there is exactly one in-progress formation (the name→SD mapping is otherwise
  // ambiguous); multiple in-progress formations fall back to the SD label.
  let chosenName = ''
  if (sds.length === 1) {
    const { data: wp } = await supabaseAdmin
      .from('wizard_progress')
      .select('data')
      .eq('contact_id', contactId)
      .eq('wizard_type', 'formation')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const wd = (wp?.data ?? {}) as Record<string, unknown>
    chosenName = String(wd.chosen_name_final || wd.chosen_name || '').trim()
  }

  return sds.map(sd => ({
    id: `formation:${sd.id}`,
    sdId: sd.id,
    label:
      (sds.length === 1 && chosenName) ||
      (sd.service_name ? sd.service_name.replace(/^Company Formation - /, '') : '') ||
      'New company (in formation)',
    stage: 'formation' as const,
    leadId: resolveLeadId(sd.notes as string | null),
  }))
}

export async function getPortalAccountDetail(accountId: string) {
  const { data } = await (supabaseAdmin as any)
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, registered_agent_provider, registered_agent_address, ra_renewal_date, filing_id, invoice_logo_url, bank_details, payment_gateway, payment_link, member_count, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
    .eq('id', accountId)
    .single()

  if (!data) return data
  return { ...data, physical_address: resolveMailingAddress(data.mailing_address, data.physical_address) }
}

export async function getPortalMembers(accountId: string) {
  // Primary source: members table (populated for accounts formed/onboarded after April 2026)
  const { data: membersRows } = await supabaseAdmin
    .from('members')
    .select('id, member_type, full_name, company_name, ein, email, phone, ownership_pct, is_primary, contact_id, representative_name, representative_email, representative_phone, address_street, address_city, address_state, address_country, representative_address_street, representative_address_city, representative_address_state, representative_address_country')
    .eq('account_id', accountId)
    .order('is_primary', { ascending: false })

  if (!membersRows || membersRows.length === 0) return []

  // Batch-fetch contacts for individual members to get first/last name split + personal details
  {
    const contactIds = membersRows
      .filter(m => m.member_type === 'individual' && m.contact_id)
      .map(m => m.contact_id!)

    let contactMap: Record<string, {
      first_name: string | null; last_name: string | null
      citizenship: string | null; date_of_birth: string | null
      address_line1: string | null; address_city: string | null; address_state: string | null; address_country: string | null
    }> = {}

    if (contactIds.length > 0) {
      const { data: contacts } = await supabaseAdmin
        .from('contacts')
        .select('id, first_name, last_name, citizenship, date_of_birth, address_line1, address_city, address_state, address_country')
        .in('id', contactIds)
      contactMap = Object.fromEntries((contacts ?? []).map(c => [c.id, c]))
    }

    return membersRows.map(m => {
      if (m.member_type === 'company') {
        return {
          member_id: m.id,
          member_type: 'company' as const,
          contact_id: m.contact_id,
          role: 'Member',
          ownership_pct: m.ownership_pct,
          is_primary: m.is_primary ?? false,
          first_name: m.company_name ?? '',
          last_name: '',
          email: m.representative_email,
          phone: m.representative_phone,
          citizenship: null,
          date_of_birth: null,
          address_line1: m.representative_address_street ?? m.address_street ?? null,
          address_city: m.representative_address_city ?? m.address_city ?? null,
          address_state: m.representative_address_state ?? m.address_state ?? null,
          address_country: m.representative_address_country ?? m.address_country ?? null,
          company_name: m.company_name,
          ein: m.ein,
          representative_name: m.representative_name,
          representative_email: m.representative_email,
          representative_phone: m.representative_phone,
        }
      }

      const contact = m.contact_id ? (contactMap[m.contact_id] ?? null) : null
      const nameParts = (m.full_name ?? '').split(' ')
      return {
        member_id: m.id,
        member_type: 'individual' as const,
        contact_id: m.contact_id,
        role: 'Member',
        ownership_pct: m.ownership_pct,
        is_primary: m.is_primary ?? false,
        first_name: contact?.first_name ?? nameParts[0] ?? '',
        last_name: contact?.last_name ?? nameParts.slice(1).join(' ') ?? '',
        email: m.email,
        phone: m.phone,
        citizenship: contact?.citizenship ?? null,
        date_of_birth: contact?.date_of_birth ?? null,
        address_line1: contact?.address_line1 ?? m.address_street ?? null,
        address_city: contact?.address_city ?? m.address_city ?? null,
        address_state: contact?.address_state ?? m.address_state ?? null,
        address_country: contact?.address_country ?? m.address_country ?? null,
        company_name: null,
        ein: null,
        representative_name: null,
        representative_email: null,
        representative_phone: null,
      }
    })
  }
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

/**
 * Client-facing "Service Status" flows for the active dashboard.
 *
 * Reads the account's ACTIVE service_deliveries of the four recurring flow
 * types (Tax Return / State Annual Report / State RA Renewal / CMRA), and for
 * each computes a client-facing progress fraction + the current stage's
 * client_label from pipeline_stages. Read-only; reuses the flow resolver's pure
 * helpers (FLOW_TYPES / deriveFlowYear / buildFlowTopic) and the pure
 * computeFlowProgress stage-position logic so it stays consistent with the
 * staff workspace and the Tax tracker.
 *
 * A flow whose stages carry no client_label (CMRA) returns totalStages=0 so the
 * UI can show a neutral "Active" state without a 0-of-0 progress bar.
 */
export interface PortalFlow {
  id: string
  flow_type: string
  title: string
  currentLabel: string | null
  completedStages: number
  totalStages: number
  dueDate: string | null
  /** Ordered visual-stepper steps; null for flows with no client-facing stages. */
  steps: FlowStep[] | null
}

export async function getPortalFlows(accountId: string, locale: 'en' | 'it', contactId?: string | null): Promise<PortalFlow[]> {
  const { FLOW_TYPES, CONTACT_FLOW_TYPES, deriveFlowYear, buildFlowTopic } = await import('@/lib/flows/resolve-flows')
  const { computeFlowProgress, buildFlowSteps } = await import('@/lib/flows/flow-progress')

  // Account-scoped flows (Tax Return, State Annual Report, State RA Renewal, CMRA).
  // Skipped when there's no account (accountId === '' for no-account/ITIN-only
  // clients) — `.eq('account_id', '')` would be an invalid-uuid error.
  const accountSds = accountId
    ? (await supabaseAdmin
        .from('service_deliveries')
        .select('id, service_type, service_name, stage, due_date, stage_entered_at, created_at')
        .eq('account_id', accountId)
        .in('service_type', FLOW_TYPES as unknown as string[])
        .eq('status', 'active')
        .order('updated_at', { ascending: false })).data
    : null

  // Contact-scoped flows (ITIN, Company Formation) — these SDs have account_id
  // NULL + a contact_id, so the account query never matches them. Only when a
  // contactId is known, filtered by CONTACT_FLOW_TYPES (FLOW_TYPES is account-
  // only by design).
  //
  // Per-company scoping (dev_task bb54680b): a Company Formation is a separate
  // SELECTABLE entity (company switcher → FormationDashboard), not a service of
  // an existing company. When a real account is selected, exclude contact-scoped
  // Company Formation so a NEW company's formation does not leak into THIS
  // company's Service Status (the "formation shows under Scaledge/Whalecot"
  // class). ITIN is also contact-scoped but legitimately rides along on an
  // active client, so it stays. No-account / ITIN-only callers (accountId === '')
  // are unaffected — and no-account formation clients render FormationDashboard
  // before this widget anyway.
  let contactSds: typeof accountSds = []
  if (contactId) {
    const contactFlowTypes = (CONTACT_FLOW_TYPES as readonly string[]).filter(
      t => !(accountId && t === 'Company Formation'),
    )
    const { data } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, service_name, stage, due_date, stage_entered_at, created_at')
      .eq('contact_id', contactId)
      .is('account_id', null)
      .in('service_type', contactFlowTypes)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
    contactSds = data ?? []
  }

  const sds = [...(accountSds ?? []), ...(contactSds ?? [])]

  if (!sds || sds.length === 0) return []

  const serviceTypes = Array.from(new Set(sds.map(s => s.service_type).filter((t): t is string => !!t)))
  const { data: stageRows } = await supabaseAdmin
    .from('pipeline_stages')
    .select('service_type, stage_name, stage_order, client_label, client_label_it, icon')
    .in('service_type', serviceTypes)

  const stagesByType = new Map<string, FlowStageRow[]>()
  for (const r of stageRows ?? []) {
    if (!r.service_type) continue
    const list = stagesByType.get(r.service_type) ?? []
    list.push({
      stage_name: r.stage_name as string,
      stage_order: (r.stage_order as number | null) ?? 0,
      client_label: (r.client_label as string | null) ?? null,
      client_label_it: (r.client_label_it as string | null) ?? null,
      icon: (r.icon as string | null) ?? null,
    })
    stagesByType.set(r.service_type, list)
  }

  return sds.map(sd => {
    const serviceType = sd.service_type ?? ''
    const stages = stagesByType.get(serviceType) ?? []
    const progress = computeFlowProgress(stages, sd.stage ?? null, locale)
    const steps = buildFlowSteps(stages, sd.stage ?? null, locale)
    const year = deriveFlowYear(sd)
    const title = buildFlowTopic(serviceType, year) || sd.service_name || serviceType || 'Service'
    return {
      id: sd.id as string,
      flow_type: serviceType,
      title,
      currentLabel: progress.currentLabel,
      completedStages: progress.completedStages,
      totalStages: progress.totalStages,
      dueDate: (sd.due_date as string | null) ?? null,
      steps,
    }
  })
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

  // Unsent drafts (Draft + Pending) are staff-internal until reviewed and
  // sent — never show them to the client (Kasabi incident, 2026-07-04).
  return (data ?? []).filter(isClientVisiblePayment)
}

/**
 * Contact-scoped payments — for clients in the formation gap (paid as
 * individual, no company yet) per Antonio's architectural model. Returns
 * payment rows attached to the contact with no account_id set.
 */
export async function getPortalPaymentsByContact(contactId: string) {
  const { data } = await supabaseAdmin
    .from('payments')
    .select('id, description, amount, amount_currency, period, year, due_date, paid_date, status, installment, invoice_number, invoice_status')
    .eq('contact_id', contactId)
    .is('account_id', null)
    .order('due_date', { ascending: false })
    .limit(20)

  // Same unsent-draft rule as getPortalPayments.
  return (data ?? []).filter(isClientVisiblePayment)
}

/**
 * Get client expenses (incoming invoices: TD billing + third-party uploads).
 * Used in the Expenses tab of the portal invoices page.
 */
export async function getPortalExpenses(accountId: string) {
  const { data } = await supabaseAdmin
    .from('client_expenses')
    .select('id, vendor_name, invoice_number, internal_ref, description, currency, total, subtotal, tax_amount, amount_due, amount_paid, issue_date, due_date, paid_date, status, source, category, attachment_url, attachment_name, td_payment_id, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(100)

  // TD-invoice mirrors of UNSENT drafts are staff-internal until reviewed and
  // sent — same rule as Payment History (Kasabi incident, 2026-07-04).
  return hideUnsentDraftMirrors(data ?? [])
}

/**
 * Drop `client_expenses` mirror rows whose linked TD invoice is an unsent
 * draft (Draft + Pending). One `payments` lookup for the mirrors present;
 * pure filtering in `filterClientVisibleExpenseMirrors` (fail-open when the
 * linked payment row is missing — never hide a real expense on data drift).
 */
async function hideUnsentDraftMirrors<
  T extends { source?: string | null; td_payment_id?: string | null },
>(rows: T[]): Promise<T[]> {
  const paymentIds = rows
    .filter(r => r.source === 'td_invoice' && r.td_payment_id)
    .map(r => r.td_payment_id as string)
  if (paymentIds.length === 0) return rows

  const { data: linked } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_status, status')
    .in('id', paymentIds)

  return filterClientVisibleExpenseMirrors(rows, linked ?? [])
}

/**
 * Contact-scoped expenses — mirror of getPortalExpenses for formation-gap
 * clients (paid as individual, no company yet). Same shape, same fields.
 */
export async function getPortalExpensesByContact(contactId: string) {
  const { data } = await supabaseAdmin
    .from('client_expenses')
    .select('id, vendor_name, invoice_number, internal_ref, description, currency, total, subtotal, tax_amount, amount_due, amount_paid, issue_date, due_date, paid_date, status, source, category, attachment_url, attachment_name, td_payment_id, created_at')
    .eq('contact_id', contactId)
    .is('account_id', null)
    .order('created_at', { ascending: false })
    .limit(100)

  // Same unsent-draft mirror rule as getPortalExpenses.
  return hideUnsentDraftMirrors(data ?? [])
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
  itinAtClientSigning: boolean // contact has an active ITIN SD at "Client Signing" stage
}

/**
 * Phase C (ITIN Chain Fix 2026-05-11): true iff the contact has an active ITIN
 * SD currently at "Client Signing" stage. ITIN SDs are contact-only by Phase 1
 * rule (account_id is forced to null), so this is queried by contact_id.
 *
 * Drives the conditional "ITIN Documents" sidebar entry and the
 * /portal/itin-documents page guard.
 */
export async function hasItinAtClientSigning(contactId: string): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from('service_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('service_type', 'ITIN')
    .eq('stage', 'Client Signing')
    .eq('status', 'active')
  return (count ?? 0) > 0
}

export interface ItinAtClientSigningView {
  sdId: string
  serviceName: string
  documents: Array<{
    id: string
    file_name: string
    document_type_name: string | null
    drive_file_id: string | null
  }>
}

/**
 * Fetch the ITIN SD at "Client Signing" for a contact, along with its W-7 +
 * 1040-NR + Schedule OI PDFs from the documents table. Returns null when the
 * contact has no such SD (caller is expected to redirect).
 *
 * Documents may be filed either contact-scoped (pure contact-only ITIN, no
 * LLC) or account-scoped (contact also owns an LLC — autoSaveDocument files
 * under the account so other members of the account can see them too). We
 * query both shapes restricted to the contact's accessible accounts and the
 * known ITIN document_type_name values written by itin-form-completed.
 */
export async function getItinAtClientSigning(contactId: string): Promise<ItinAtClientSigningView | null> {
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name')
    .eq('contact_id', contactId)
    .eq('service_type', 'ITIN')
    .eq('stage', 'Client Signing')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!sd) return null

  // The PDF rows written by app/api/itin-form-completed/route.ts use these
  // document_type_name values (R093: verified at lines 332-335 of that file).
  const ITIN_DOC_TYPES = ['ITIN W-7', 'ITIN 1040-NR', 'ITIN Schedule OI']

  // Account-linked ITINs save docs under the contact's account(s). Look those
  // up so we don't miss them.
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contactId)
  const accountIds = (links ?? []).map(l => l.account_id).filter((id): id is string => typeof id === 'string')

  // Build the OR filter: contact-scoped docs (contact_id=this contact AND
  // account_id IS NULL) OR account-scoped docs (account_id IN this contact's
  // accounts). Supabase's .or() doesn't compose .and() inline cleanly, so we
  // do two queries and merge.
  const contactScopedQ = supabaseAdmin
    .from('documents')
    .select('id, file_name, document_type_name, drive_file_id, created_at')
    .is('account_id', null)
    .eq('contact_id', contactId)
    .in('document_type_name', ITIN_DOC_TYPES)
    .eq('portal_visible', true)

  const accountScopedQ = accountIds.length
    ? supabaseAdmin
        .from('documents')
        .select('id, file_name, document_type_name, drive_file_id, created_at')
        .in('account_id', accountIds)
        .in('document_type_name', ITIN_DOC_TYPES)
        .eq('portal_visible', true)
    : Promise.resolve({ data: [] as Array<{ id: string; file_name: string; document_type_name: string | null; drive_file_id: string | null; created_at: string }> })

  const [contactDocsRes, accountDocsRes] = await Promise.all([contactScopedQ, accountScopedQ])

  // Dedup by document id (in case any row qualifies via both filters) and
  // sort W-7 → 1040-NR → Schedule OI for a stable reading order. Fall back
  // to filename comparison for unknowns.
  const ORDER = new Map([
    ['ITIN W-7', 0],
    ['ITIN 1040-NR', 1],
    ['ITIN Schedule OI', 2],
  ])
  const merged = new Map<string, { id: string; file_name: string; document_type_name: string | null; drive_file_id: string | null }>()
  for (const d of [...(contactDocsRes.data ?? []), ...(accountDocsRes.data ?? [])]) {
    if (!merged.has(d.id)) {
      merged.set(d.id, {
        id: d.id,
        file_name: d.file_name,
        document_type_name: d.document_type_name,
        drive_file_id: d.drive_file_id,
      })
    }
  }
  const documents = Array.from(merged.values()).sort((a, b) => {
    const ao = ORDER.get(a.document_type_name ?? '') ?? 99
    const bo = ORDER.get(b.document_type_name ?? '') ?? 99
    if (ao !== bo) return ao - bo
    return a.file_name.localeCompare(b.file_name)
  })

  return {
    sdId: sd.id,
    serviceName: sd.service_name || 'ITIN',
    documents,
  }
}

export async function getPortalNavVisibility(accountId: string, contactId?: string): Promise<PortalNavVisibility> {
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

  // ITIN visibility is contact-scoped (SDs are contact-only by Phase 1 rule),
  // not account-scoped. Skip the lookup if the caller didn't pass contactId.
  const itinAtClientSigning = contactId ? await hasItinAtClientSigning(contactId) : false

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
    itinAtClientSigning,
  }
}

/**
 * Get the portal tier for an account.
 * Returns 'lead', 'formation', 'onboarding', or 'active'.
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
 *
 * Phase C (2026-05-11): accepts optional contactId so the ITIN-at-Client-Signing
 * flag can light up for pure contact-only ITIN clients. When contactId is
 * omitted, falls back to the legacy hardcoded shape.
 */
export async function getContactOnlyNavVisibility(contactId?: string): Promise<PortalNavVisibility> {
  const itinAtClientSigning = contactId ? await hasItinAtClientSigning(contactId) : false
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
    itinAtClientSigning,
  }
}

/**
 * Count unread admin messages for a client.
 * Used for the chat badge in the sidebar.
 *
 * PR 2 Step 6 (2026-05-05): unified per-contact thread. The badge counts
 * unread admin messages across BOTH personal and company scopes for the
 * contact. Switching the company switcher in the sidebar no longer changes
 * the count.
 */
export async function getUnreadChatCount(contactId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('portal_messages')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('sender_type', 'admin')
    .or('read_at.is.null,client_kept_unread.eq.true')
    .is('deleted_at', null)
  return count ?? 0
}

export async function getPortalTaxReturns(accountId: string) {
  // Tax returns are matched by company_name, not account_id. We also fetch the
  // matching Tax Return SD's status so the portal home can show the
  // "extension filed" pause banner when the SD is on_hold (R093: status is the
  // source of truth per-account — we attach it to every tr row for
  // convenience, since there's at most one active Tax Return SD per account).
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', accountId)
    .single()

  if (!account?.company_name) return []

  const [taxRes, sdRes, subRes] = await Promise.all([
    supabaseAdmin
      .from('tax_returns')
      .select('id, tax_year, return_type, status, deadline, extension_filed, extension_deadline, extension_submission_id, data_received, sent_to_accountant')
      .eq('company_name', account.company_name)
      .order('tax_year', { ascending: false })
      .limit(5),
    supabaseAdmin
      .from('service_deliveries')
      .select('status, stage')
      .eq('account_id', accountId)
      .eq('service_type', 'Tax Return')
      .not('status', 'in', '(completed,cancelled)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Latest submission per account — review_status drives the portal banner.
    // Keyed by account_id + most recent created_at; we fetch one row and match
    // against the banner tax return by tax_year inside the map below.
    supabaseAdmin
      .from('tax_return_submissions')
      .select('id, tax_year, review_status')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const sdStatus = sdRes.data?.status ?? null
  const sdStage = sdRes.data?.stage ?? null
  const submissions = subRes.data ?? []

  return (taxRes.data ?? []).map(tr => {
    // Find the most recent submission for this tax year (submissions are already
    // ordered newest-first, so `.find` returns the right one).
    const sub = submissions.find(s => s.tax_year === tr.tax_year) ?? null
    return {
      ...tr,
      sd_status: sdStatus,
      sd_stage: sdStage,
      review_status: (sub?.review_status ?? null) as string | null,
      submission_id: sub?.id ?? null,
    }
  })
}

/**
 * Catalog stages for the Tax Return client progress tracker (Slice 5).
 * Account-independent — the catalog defines the journey; the client's SD
 * stage (from getPortalTaxReturns) marks the position. Membership/labels are
 * catalog-driven: only stages with a client_label render (see
 * lib/tax/progress-tracker.ts for the mapping rules).
 */
export async function getTaxTrackerCatalogStages() {
  const { data } = await supabaseAdmin
    .from('pipeline_stages')
    .select('stage_name, stage_order, client_label, client_label_it, icon')
    .eq('service_type', 'Tax Return')
    .order('stage_order', { ascending: true })
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

/**
 * Maps a service_deliveries.service_type value to the matching wizard_type
 * the portal wizard renders for it. Used to surface "Start ⟨Wizard⟩"
 * action-item cards when an active SD exists but the client hasn't started
 * the wizard yet (no wizard_progress row). Banking is intentionally omitted
 * because /portal/wizard renders a Payset/Relay picker for it and the
 * picker itself acts as the entry point.
 */
const SD_WIZARD_TYPE_BY_SERVICE_TYPE: Record<string, string> = {
  'Company Formation': 'formation',
  'Company Closure': 'closure',
  'ITIN': 'itin',
  'ITIN Renewal': 'itin',
  'Tax Return': 'tax',
}

function wizardTypeForServiceType(serviceType: string): string | null {
  return SD_WIZARD_TYPE_BY_SERVICE_TYPE[serviceType] ?? null
}

// The two local label switches that used to live here are gone. They knew
// itin/closure but not the banking types, so a banking wizard fell through to
// `default` and rendered its internal code to the client. Every title on this
// page is now built by completeWizardFormTitle / startWizardFormTitle in
// ./wizard-labels, which own the sentence as well as the noun.

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
    // 1. In-progress wizard forms — SCOPED TO THE SELECTED ACCOUNT ONLY.
    // Per-company scoping (dev_task bb54680b): a contact-scoped wizard
    // (account_id NULL — e.g. a Company Formation for a brand-new company) or a
    // wizard belonging to another of the client's companies must NOT surface
    // under this company's action items. The formation / no-account view uses
    // getPortalActionItemsByContact (contact-scoped) for those instead.
    accountId
      ? supabaseAdmin
          .from('wizard_progress')
          .select('id, wizard_type, created_at, updated_at')
          .eq('status', 'in_progress')
          .eq('account_id', accountId)
          .limit(10)
      : Promise.resolve({ data: [] as Array<{ id: string; wizard_type: string; created_at: string; updated_at: string }> }),

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

    // 6. Unsigned Annual MSA (annual agreements not yet signed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from('annual_agreements')
      .select('id, token, status, created_at')
      .eq('account_id', accountId)
      .in('status', ['draft', 'sent', 'viewed'])
      .limit(5) as Promise<{ data: Array<{ id: string; token: string; status: string; created_at: string }> | null }>,

    // 7. Pending tax returns (data not yet collected from client).
    // Excludes rows already "Data Received" / past-data-receipt states and
    // rows marked "TR Filed" — those are done from the client's POV so the
    // "Complete Tax Information" CTA would be stale.
    acctForTax?.company_name
      ? supabaseAdmin
          .from('tax_returns')
          .select('id, tax_year, return_type, created_at, status')
          .eq('company_name', acctForTax.company_name)
          .eq('data_received', false)
          .not('status', 'in', '("TR Filed","Data Received","Sent to Accountant","Sent to India","Payment Pending")')
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
  // Gate: some wizard types require an active SD to be actionable.
  // banking_payset/banking_relay need Banking Fintech; tax needs Tax Return.
  // Without the gate, orphaned in_progress wizard_progress rows (e.g. from
  // SDs deleted during data cleanup) surface as action items that fail on submit.
  // onboarding has no SD at payment (deferred per SOP v7.2) — no gate for it.
  const WIZARD_SD_REQUIRED: Record<string, string> = {
    banking_payset: 'Banking Fintech',
    banking_relay: 'Banking Fintech',
    tax: 'Tax Return',
  }
  const requiredSdTypes = Array.from(new Set(Object.values(WIZARD_SD_REQUIRED)))
  const { data: activeWizardSds } = await supabaseAdmin
    .from('service_deliveries')
    .select('service_type')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .in('service_type', requiredSdTypes)
  const activeWizardSdTypes = new Set((activeWizardSds ?? []).map(s => s.service_type))

  // Tax wizard cards additionally require the shared eligibility resolver to
  // say the wizard is actually open (open tax_returns row + formation-year
  // guard + wizard-open SD stage) or in its client-editable review loop.
  // Before this gate (PTBT incident, dev job 8cc8e1c8) ANY active Tax Return
  // SD — including one parked pre-season at "1st Installment Paid" — surfaced
  // a "Start Tax Return Form" card whose ?type=tax link bypassed every check.
  const taxEligibility = await resolveTaxWizardEligibility({ accountId, contactId })
  const taxWizardActionable = taxEligibility.mode === 'open' || taxEligibility.mode === 'review'

  // Track wizard_types we already have an in_progress card for, so the
  // SD-driven "Start <Wizard>" pass below doesn't double up.
  const inProgressWizardTypes = new Set<string>()

  for (const w of wizardRes.data ?? []) {
    const requiredSd = WIZARD_SD_REQUIRED[w.wizard_type]
    if (requiredSd && !activeWizardSdTypes.has(requiredSd)) continue
    if ((w.wizard_type === 'tax' || w.wizard_type === 'tax_return') && !taxWizardActionable) continue

    inProgressWizardTypes.add(w.wizard_type)

    const age = daysSince(w.created_at)
    const priority: ActionItem['priority'] = age > 7 ? 'red' : age > 3 ? 'orange' : 'blue'
    items.push({
      type: 'form',
      title: completeWizardFormTitle(w.wizard_type, 'en'),
      titleIt: completeWizardFormTitle(w.wizard_type, 'it'),
      description: 'Your data collection form is in progress. Please complete it.',
      descriptionIt: 'Il tuo modulo di raccolta dati è in corso. Completalo.',
      href: `/portal/wizard?type=${w.wizard_type}`,
      priority,
      createdAt: w.created_at,
    })
  }

  // ── SD-driven "Start <Wizard>" cards ──
  // For each active wizard-eligible SD on the account (and contact-scoped
  // flexible-type SDs like Company Closure) where the client hasn't started
  // the wizard yet (no in_progress wizard_progress for that type, and no
  // submitted one either), surface a card linking directly to that wizard.
  // This is what makes Closure (or any newly-attached SD) reachable from the
  // home page without the client needing to know the URL.
  const FLEXIBLE_SDS_TO_CHECK = ['Company Closure']
  const SD_TYPES_TO_SURFACE = Object.keys(SD_WIZARD_TYPE_BY_SERVICE_TYPE)

  const [accountSdsRes, contactFlexibleSdsRes, submittedWizardRes] = await Promise.all([
    supabaseAdmin
      .from('service_deliveries')
      .select('service_type, created_at')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .in('service_type', SD_TYPES_TO_SURFACE),
    contactId
      ? supabaseAdmin
          .from('service_deliveries')
          .select('service_type, created_at')
          .eq('contact_id', contactId)
          .is('account_id', null)
          .eq('status', 'active')
          .in('service_type', FLEXIBLE_SDS_TO_CHECK)
      : Promise.resolve({ data: [] as Array<{ service_type: string; created_at: string }> }),
    // Submitted wizards — SCOPED TO THE SELECTED ACCOUNT ONLY, mirroring the
    // in-progress query above. Tax / onboarding / banking submissions are
    // account-scoped, so this still finds them; scoping by contact_id would
    // let a submission for another of the client's companies wrongly suppress
    // (or surface) a "Start ⟨Wizard⟩" card here (per-company scoping, bb54680b).
    supabaseAdmin
      .from('wizard_progress')
      .select('wizard_type')
      .eq('status', 'submitted')
      .eq('account_id', accountId),
  ])

  const submittedWizardTypes = new Set((submittedWizardRes.data ?? []).map(w => w.wizard_type))
  const sdSurfacedWizards = new Set<string>()
  const candidateSds: Array<{ service_type: string; created_at: string }> = [
    ...(accountSdsRes.data ?? []),
    ...(contactFlexibleSdsRes.data ?? []),
  ]

  for (const sd of candidateSds) {
    const wt = wizardTypeForServiceType(sd.service_type)
    if (!wt) continue
    if (wt === 'tax' && !taxWizardActionable) continue
    if (inProgressWizardTypes.has(wt)) continue
    if (submittedWizardTypes.has(wt)) continue
    if (sdSurfacedWizards.has(wt)) continue
    sdSurfacedWizards.add(wt)

    const age = daysSince(sd.created_at)
    const priority: ActionItem['priority'] = age > 7 ? 'red' : age > 3 ? 'orange' : 'blue'
    items.push({
      type: 'form',
      // sd.service_type distinguishes ITIN Renewal from ITIN Application —
      // both open the same wizard, but the card must name what they bought.
      title: startWizardFormTitle(wt, 'en', sd.service_type),
      titleIt: startWizardFormTitle(wt, 'it', sd.service_type),
      description: 'Click to begin your data collection form.',
      descriptionIt: 'Clicca per iniziare il modulo di raccolta dati.',
      href: `/portal/wizard?type=${wt}`,
      priority,
      createdAt: sd.created_at,
    })
  }

  // ── Pending tax returns (assigned but client hasn't submitted data yet) ──
  // Skip this item entirely when the Tax Return SD is on_hold — the portal
  // home already renders the "extension filed" pause banner which carries
  // the "no action needed" message; showing a "Complete Tax Information"
  // CTA alongside it contradicts that banner.
  const { data: trSdForPause } = await supabaseAdmin
    .from('service_deliveries')
    .select('status')
    .eq('account_id', accountId)
    .eq('service_type', 'Tax Return')
    .not('status', 'in', '(completed,cancelled)')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const taxReturnSdOnHold = trSdForPause?.status === 'on_hold'

  // Tax years for which the client has already SUBMITTED their data for THIS
  // account. The pending tax cards below are otherwise gated only on
  // tax_returns.data_received=false, but that flag is flipped by a downstream
  // job (tax-form-setup) that can lag or fail — leaving a stale "Complete Tax
  // Information — <year>" card for months after the client actually submitted
  // (dev_task bb54680b). A tax_return_submissions row is written synchronously
  // at submit and carries the tax_year, so it's the authoritative, YEAR-ACCURATE
  // "client did their part" signal. Year-accurate matters for annual clients: a
  // prior year's submission must NOT suppress the current year's card.
  const { data: submittedTaxRows } = await supabaseAdmin
    .from('tax_return_submissions')
    .select('tax_year')
    .eq('account_id', accountId)
  const submittedTaxYears = new Set(
    (submittedTaxRows ?? [])
      .map(r => (r as { tax_year: number | null }).tax_year)
      .filter((y): y is number => y != null),
  )

  for (const tr of (taxRes as { data: Array<{ id: string; tax_year: number; return_type: string; created_at: string }> | null }).data ?? []) {
    // Skip when the shared resolver says the wizard isn't actionable — this
    // sibling card previously contradicted the SD-card gating (it filtered
    // only on tax_returns.status, not the SD stage / formation guard).
    if (!taxWizardActionable) continue
    // Skip when the SD is on_hold (pause banner covers the communication).
    if (taxReturnSdOnHold) continue
    // Skip when the client already submitted THIS tax year's data (year-accurate).
    if (submittedTaxYears.has(tr.tax_year)) continue
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
    // Normalize: production still stores the legacy long form ("Multi Member
    // LLC") on some rows. Compared raw, such a company reads as single-member
    // here — so the "has THIS member already signed?" skip below never runs and
    // a member who has signed keeps being told their signature is needed, while
    // the description omits the "x of y members have signed" progress.
    const isMultiSigner = normalizeEntityType(oaAny.entity_type) === 'MMLLC' && (oaAny.total_signers || 1) > 1

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
      // Same destination as the email/chat notification for this agreement, and
      // carrying the company — the two used to disagree (dashboard sent you to
      // the list, the email to the document), and neither said which company,
      // so a client with more than one could land on the wrong one.
      href: `/portal/sign/oa?account=${accountId}`,
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
 * Contact-only variant of getPortalActionItems — for clients in the formation
 * gap (paid as individual, no company yet) and for tier=lead/onboarding
 * clients without an account. Replaces the broken
 * `getPortalActionItems(undefined, contactId)` call which silently returned
 * nothing because the underlying query did `.eq('id', accountId).single()`
 * with accountId=undefined.
 *
 * Surfaces the items that make sense at the contact scope:
 * - In-progress wizard forms (formation, onboarding, tax)
 * - Unpaid invoices on the contact (account_id IS NULL)
 *
 * Skips OA/Lease/SS-4/MSA/tax-returns/signature-requests because none of
 * those exist before the company is materialized.
 */
export async function getPortalActionItemsByContact(contactId: string): Promise<ActionItemsResult> {
  const today = new Date().toISOString().split('T')[0]

  const [wizardRes, invoiceRes] = await Promise.all([
    supabaseAdmin
      .from('wizard_progress')
      .select('id, wizard_type, created_at, updated_at')
      .eq('status', 'in_progress')
      .eq('contact_id', contactId)
      .limit(10),
    supabaseAdmin
      .from('payments')
      .select('id, invoice_number, total, amount_currency, due_date, invoice_status, created_at')
      .eq('contact_id', contactId)
      .is('account_id', null)
      .in('invoice_status', ['Sent', 'Overdue'])
      .order('due_date', { ascending: true })
      .limit(10),
  ])

  const items: ActionItem[] = []

  // ── Wizard forms ──
  // No SD-required gating at contact scope: formation/onboarding wizards
  // attached to the contact don't have an account yet, so we can't check
  // service_deliveries.account_id. Trust the wizard_progress row exists.
  const inProgressWizardTypesByContact = new Set<string>()
  for (const w of wizardRes.data ?? []) {
    inProgressWizardTypesByContact.add(w.wizard_type)
    const age = daysSince(w.created_at)
    const priority: ActionItem['priority'] = age > 7 ? 'red' : age > 3 ? 'orange' : 'blue'
    items.push({
      type: 'form',
      title: completeWizardFormTitle(w.wizard_type, 'en'),
      titleIt: completeWizardFormTitle(w.wizard_type, 'it'),
      description: 'Your data collection form is in progress. Please complete it.',
      descriptionIt: 'Il tuo modulo di raccolta dati è in corso. Completalo.',
      href: `/portal/wizard?type=${w.wizard_type}`,
      priority,
      createdAt: w.created_at,
    })
  }

  // ── SD-driven "Start <Wizard>" cards (contact scope) ──
  // Same pattern as the account-scope variant: surface a card per active
  // wizard-eligible SD on the contact (account_id IS NULL) where the client
  // hasn't started the wizard yet.
  const SD_TYPES_TO_SURFACE_CONTACT = Object.keys(SD_WIZARD_TYPE_BY_SERVICE_TYPE)
  const [contactSdsRes, contactSubmittedRes] = await Promise.all([
    supabaseAdmin
      .from('service_deliveries')
      .select('service_type, created_at')
      .eq('contact_id', contactId)
      .is('account_id', null)
      .eq('status', 'active')
      .in('service_type', SD_TYPES_TO_SURFACE_CONTACT),
    supabaseAdmin
      .from('wizard_progress')
      .select('wizard_type')
      .eq('contact_id', contactId)
      .eq('status', 'submitted'),
  ])
  const submittedWizardTypesByContact = new Set((contactSubmittedRes.data ?? []).map(w => w.wizard_type))
  const sdSurfacedWizardsByContact = new Set<string>()

  for (const sd of contactSdsRes.data ?? []) {
    let wt = wizardTypeForServiceType(sd.service_type)
    if (!wt) continue
    // ── Tax, for a client with no company yet, is ALWAYS company_info ────────
    // This loop is accountless by construction (the query above filters
    // `account_id IS NULL`), and `decideTaxWizardEligibility` returns
    // `company_info` for every accountless subject — unconditionally, before any
    // other check (lib/tax/wizard-eligibility.ts). The wizard page knows this and
    // rewrites `?type=tax` to company_info, so the client DID land on the right
    // form; the card just promised them a different one ("Tax Return — start
    // your form" → a page headed "Company Information").
    //
    // Mapping it here rather than gating it out is deliberate: suppressing the
    // card would leave these clients with NO entry point at all. It also fixes
    // the dedup below, which was asking whether a `tax` wizard was already in
    // progress when the wizard they actually fill in is `company_info`.
    if (wt === 'tax') wt = 'company_info'
    if (inProgressWizardTypesByContact.has(wt)) continue
    if (submittedWizardTypesByContact.has(wt)) continue
    if (sdSurfacedWizardsByContact.has(wt)) continue
    sdSurfacedWizardsByContact.add(wt)

    const age = daysSince(sd.created_at)
    const priority: ActionItem['priority'] = age > 7 ? 'red' : age > 3 ? 'orange' : 'blue'
    items.push({
      type: 'form',
      // sd.service_type distinguishes ITIN Renewal from ITIN Application —
      // both open the same wizard, but the card must name what they bought.
      title: startWizardFormTitle(wt, 'en', sd.service_type),
      titleIt: startWizardFormTitle(wt, 'it', sd.service_type),
      description: 'Click to begin your data collection form.',
      descriptionIt: 'Clicca per iniziare il modulo di raccolta dati.',
      href: `/portal/wizard?type=${wt}`,
      priority,
      createdAt: sd.created_at,
    })
  }

  // ── Unpaid invoices (contact-scoped) ──
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

/**
 * Profile-completion banner eligibility for tax-return-standalone clients.
 *
 * Shows the banner when:
 *   (1) at least one of the contact's linked accounts is a "tax-return-standalone"
 *       — has a Tax Return SD and NO Formation/Onboarding/Closure SD, AND
 *   (2) the contact itself is missing at least one of the targeted fields
 *       (phone, 5 address fields, date_of_birth, citizenship).
 *
 * Fields the banner will ask the client to fill are returned in
 * `missingFields` so the component can render just those inputs.
 *
 * Per-account detection (not per-contact) — a contact linked to both a
 * bundled account and a standalone one still qualifies; the current 56-audit
 * list Antonio asked for flagged ~62 accounts this way.
 */
export interface ProfileBannerStatus {
  shouldShow: boolean
  missingFields: string[]
}

const PROFILE_BANNER_FIELDS = [
  'phone',
  'address_line1',
  'address_city',
  'address_state',
  'address_zip',
  'address_country',
  'date_of_birth',
  'citizenship',
] as const

const TAX_STANDALONE_EXCLUDING_SERVICES = new Set([
  'Company Formation',
  'Client Onboarding',
  'Company Closure',
])

export async function getProfileBannerStatus(contactId: string): Promise<ProfileBannerStatus> {
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('phone, address_line1, address_city, address_state, address_zip, address_country, date_of_birth, citizenship')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact) return { shouldShow: false, missingFields: [] }

  const missingFields: string[] = []
  for (const f of PROFILE_BANNER_FIELDS) {
    const v = (contact as unknown as Record<string, unknown>)[f]
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      missingFields.push(f)
    }
  }
  if (missingFields.length === 0) return { shouldShow: false, missingFields: [] }

  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contactId)
  const accountIds = (links ?? [])
    .map(l => l.account_id)
    .filter((id): id is string => typeof id === 'string')
  if (accountIds.length === 0) return { shouldShow: false, missingFields: [] }

  const { data: sds } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id, service_type')
    .in('account_id', accountIds)
  const serviceTypesPerAccount = new Map<string, Set<string>>()
  for (const sd of sds ?? []) {
    if (!sd.account_id) continue
    if (!serviceTypesPerAccount.has(sd.account_id)) serviceTypesPerAccount.set(sd.account_id, new Set())
    serviceTypesPerAccount.get(sd.account_id)!.add(sd.service_type)
  }

  const perAccountLists = Array.from(serviceTypesPerAccount.values())
  for (const serviceTypes of perAccountLists) {
    const hasTaxReturn = serviceTypes.has('Tax Return')
    if (!hasTaxReturn) continue
    const types = Array.from(serviceTypes)
    const hasExcluded = types.some(t => TAX_STANDALONE_EXCLUDING_SERVICES.has(t))
    if (!hasExcluded) {
      return { shouldShow: true, missingFields }
    }
  }

  return { shouldShow: false, missingFields: [] }
}
