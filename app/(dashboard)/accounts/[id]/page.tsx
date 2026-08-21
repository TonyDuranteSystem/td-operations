import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { notFound } from 'next/navigation'
import { AccountDetail } from '@/components/accounts/account-detail'
import { APP_BASE_URL } from '@/lib/config'
import { isDashboardUser } from '@/lib/auth'
import { ViewAsClientButton } from '@/components/accounts/view-as-client-button'
import { isOwnerRole, pickViewAsContactId } from '@/lib/portal/pick-view-as-contact'
import { getClientLoginContactIds } from '@/lib/portal/client-login-index'
import { resolveAccountSigner } from '@/lib/members/resolve-signer'
import { getBankReferralsForAccount } from '@/lib/bank-referrals'
import { resolveFlows } from '@/lib/flows/resolve-flows'
import { FormationWorkspaceBanner } from '@/components/flows/formation-workspace-banner'
import { TaxWorkspaceBanner } from '@/components/flows/tax-workspace-banner'
import type { Account, Contact, Service, Payment, Deal, TaxReturn } from '@/lib/types'

interface DocumentRecord {
  id: string
  file_name: string
  document_type_name: string | null
  category_name: string | null
  category: number | null
  confidence: string | null
  drive_file_id: string | null
  drive_link: string | null
  status: string | null
  processed_at: string | null
  mime_type: string | null
  file_size: number | null
  portal_visible: boolean
}

export default async function AccountDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = user ? isDashboardUser(user) : false
  const today = new Date().toISOString().split('T')[0]

  // Fetch account
  const { data: account } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!account) notFound()

  // Fetch partner name if linked
  let partnerName: string | null = null
  if (account.partner_id) {
    const { data: partner } = await supabaseAdmin
      .from('client_partners')
      .select('partner_name')
      .eq('id', account.partner_id)
      .single()
    partnerName = partner?.partner_name ?? null
  }

  // Fetch related data in parallel
  const [contactsResult, servicesResult, paymentsResult, dealsResult, taxReturnsResult, documentsResult, offerResult, , wizardProgressResult, signerResult] = await Promise.all([
    // Contacts via junction table
    supabase
      .from('account_contacts')
      .select('role, contact:contacts(*)')
      .eq('account_id', params.id)
      // Deterministic order: without it, Postgres row order decided who the
      // fallback "primary contact" was, and it could change between loads.
      .order('contact_id'),
    // Services (from service_deliveries — source of truth)
    supabase
      .from('service_deliveries')
      .select('id, service_name, service_type, stage, stage_order, status, start_date, end_date, notes, updated_at, account_id, contact_id')
      .eq('account_id', params.id)
      .neq('status', 'cancelled')
      .order('updated_at', { ascending: false }),
    // Payments
    supabase
      .from('payments')
      .select('id, description, amount, amount_currency, period, year, due_date, paid_date, status, payment_method, invoice_number, installment, amount_paid, amount_due, followup_stage, notes, updated_at, invoice_status, portal_invoice_id, total')
      .eq('account_id', params.id)
      .order('due_date', { ascending: false }),
    // Deals
    supabase
      .from('deals')
      .select('id, deal_name, stage, amount, amount_currency, close_date, deal_type, deal_category, service_type, payment_status, notes, created_at, updated_at')
      .eq('account_id', params.id)
      .order('created_at', { ascending: false }),
    // Tax Returns (matched by company_name)
    supabase
      .from('tax_returns')
      .select('id, company_name, client_name, return_type, tax_year, deadline, status, paid, data_received, sent_to_accountant, accountant_status, special_case, extension_filed, extension_deadline, notes, updated_at')
      .eq('company_name', account.company_name)
      .order('tax_year', { ascending: false }),
    // Documents
    supabase
      .from('documents')
      .select('id, file_name, document_type_name, category_name, category, confidence, drive_file_id, drive_link, status, processed_at, mime_type, file_size, portal_visible')
      .eq('account_id', params.id)
      .order('processed_at', { ascending: false }),
    // Offer (latest for this account)
    supabase
      .from('offers')
      .select('token, status, contract_type, cost_summary, bundled_pipelines, view_count, viewed_at, created_at, required_documents')
      .eq('account_id', params.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Pending activation (for journey tracker — fetched after offer token is known)
    Promise.resolve({ data: null }),
    // Wizard progress (for journey tracker — fetch ALL wizards)
    supabaseAdmin
      .from('wizard_progress')
      .select('status, current_step, wizard_type, updated_at, account_id, data')
      .eq('account_id', params.id)
      .order('updated_at', { ascending: false }),
    // Who actually signs/represents this account — the shared resolver
    // (is_signer-first for MMLLC, blocks rather than guesses on 0/2+ flagged,
    // falls back to account_contacts for SMLLC/legacy). account_contacts.role
    // is free text that frequently leaves everyone 'Member' with nobody
    // marked owner (B&P International, 2026-08-20: View-as and the e-sign
    // prefill both landed on the wrong co-member because they only read
    // account_contacts). Do NOT hand-roll a members.is_primary lookup here —
    // is_primary and is_signer are independently-settable and not guaranteed
    // to agree (components/portal/operating-agreement-template.tsx:41-44);
    // resolveAccountSigner is the single shared primitive for this exact
    // question (lib/members/resolve-signer.ts) and already uses supabaseAdmin
    // internally, so it isn't blocked by members' client-only RLS policy.
    resolveAccountSigner(params.id),
  ])

  const contacts: Contact[] = (contactsResult.data ?? []).map(c => {
    const contact = c.contact as unknown as Contact
    return { ...contact, role: c.role }
  })

  // The resolved signer's contact id, when the resolver found exactly one
  // unambiguous match among this account's linked contacts. A 'blocked' or
  // 'not_found' outcome (no members rows, or an MMLLC with 0/2+ signers
  // flagged) falls through to the pre-existing role/positional logic below —
  // never guess a second time.
  const resolvedSignerContact =
    signerResult.outcome === 'resolved'
      ? contacts.find((c) => c.id === signerResult.contact.id) ?? null
      : null

  const services: Service[] = (servicesResult.data ?? []).map(sd => ({
    id: sd.id,
    service_name: sd.service_name ?? sd.service_type ?? 'Service',
    service_type: sd.service_type ?? '',
    account_id: sd.account_id,
    status: sd.status === 'active' ? 'In Progress' : sd.status === 'completed' ? 'Completed' : sd.status,
    start_date: sd.start_date ?? null,
    end_date: sd.end_date ?? null,
    billing_type: null,
    amount: null,
    amount_currency: null,
    current_step: null,
    total_steps: null,
    blocked_waiting_external: null,
    blocked_reason: null,
    sla_due_date: null,
    notes: sd.notes ?? null,
    updated_at: sd.updated_at,
  })) as Service[]
  const payments: Payment[] = (paymentsResult.data ?? []).map(p => ({ ...p, account_id: params.id })) as unknown as Payment[]
  const deals: Deal[] = (dealsResult.data ?? []).map(d => ({ ...d, account_id: params.id })) as Deal[]
  const taxReturns: TaxReturn[] = (taxReturnsResult.data ?? []) as TaxReturn[]
  const documents = (documentsResult.data ?? []) as DocumentRecord[]
  const offer = offerResult.data as {
    token: string
    status: string
    contract_type: string | null
    cost_summary: Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null
    bundled_pipelines: string[] | null
    view_count: number
    viewed_at: string | null
    created_at: string
    required_documents: Array<{ id: string; name: string }> | null
  } | null

  // Fetch pending activation for this offer (if exists)
  let pendingActivation: {
    signed_at: string | null
    payment_confirmed_at: string | null
    payment_method: string | null
    activated_at: string | null
    status: string | null
  } | null = null

  if (offer?.token) {
    const { data: pa } = await supabaseAdmin
      .from('pending_activations')
      .select('signed_at, payment_confirmed_at, payment_method, activated_at, status')
      .eq('offer_token', offer.token)
      .maybeSingle()
    pendingActivation = pa
  }

  const allWizardEntries = (wizardProgressResult.data ?? []) as Array<{
    status: string
    current_step: number
    wizard_type: string
    updated_at: string
    data: Record<string, unknown> | null
  }>

  // Merge canonical "data received" signals from the domain tables into the
  // wizard-card feed. The Client Wizard Submissions card used to read only
  // wizard_progress — but for every wizard type there's a domain-specific
  // completion signal that's authoritative regardless of channel (CRM flip,
  // India-team handoff, legacy import, portal wizard submit). Without this,
  // the card shows "Not Started" for accounts whose data IS received.
  //
  // Canonical signals per wizard type:
  //   tax             — tax_returns.data_received = true (any year)
  //   banking_payset  — banking_submissions.provider='payset' + completed_at
  //   banking_relay   — banking_submissions.provider='relay'  + completed_at
  //   itin            — itin_submissions.completed_at
  //   formation       — formation_submissions.completed_at (via contact_id)
  //   onboarding      — onboarding_submissions.completed_at
  //   closure         — closure_submissions.completed_at
  //
  // We fetch all submissions for this account in parallel, then UPSERT one
  // "submitted" entry per wizard type if the canonical signal says yes and
  // no wizard_progress row already has a submitted entry for that type.
  const contactIds = contacts.map(c => c.id).filter(Boolean) as string[]
  const contactIdList = contactIds.length ? contactIds.map(id => `"${id}"`).join(',') : '"00000000-0000-0000-0000-000000000000"'

  const [bankingRes, itinRes, formationRes, onboardingRes, closureRes] = await Promise.all([
    supabaseAdmin
      .from('banking_submissions')
      .select('provider, completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false }),
    supabaseAdmin
      .from('itin_submissions')
      .select('completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1),
    contactIds.length
      ? supabaseAdmin
          .from('formation_submissions')
          .select('completed_at, status, updated_at, contact_id')
          .in('contact_id', contactIds)
          .not('completed_at', 'is', null)
          .order('completed_at', { ascending: false })
          .limit(1)
      : Promise.resolve({ data: [] }),
    supabaseAdmin
      .from('onboarding_submissions')
      .select('completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1),
    supabaseAdmin
      .from('closure_submissions')
      .select('completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1),
  ])
  // Touch contactIdList so linter doesn't flag (unused fallback for typing)
  void contactIdList

  type WizardEntry = (typeof allWizardEntries)[number]
  const syntheticEntries: WizardEntry[] = []

  // Tax — tax_returns.data_received=true, latest updated_at
  const latestReceivedTR = [...taxReturns]
    .filter(tr => tr.data_received === true)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0]
  if (latestReceivedTR) {
    syntheticEntries.push({
      status: 'submitted',
      current_step: 0,
      wizard_type: 'tax',
      updated_at: latestReceivedTR.updated_at ?? new Date().toISOString(),
      data: null,
    })
  }

  // Banking — one entry per provider if that provider has a completed submission
  const bankingRows = (bankingRes.data ?? []) as Array<{ provider: string | null; completed_at: string | null; updated_at: string | null }>
  const latestPayset = bankingRows.find(r => r.provider === 'payset')
  const latestRelay = bankingRows.find(r => r.provider === 'relay')
  if (latestPayset) syntheticEntries.push({ status: 'submitted', current_step: 0, wizard_type: 'banking_payset', updated_at: latestPayset.completed_at ?? latestPayset.updated_at ?? new Date().toISOString(), data: null })
  if (latestRelay) syntheticEntries.push({ status: 'submitted', current_step: 0, wizard_type: 'banking_relay', updated_at: latestRelay.completed_at ?? latestRelay.updated_at ?? new Date().toISOString(), data: null })

  // Single-type wizards — each maps one-to-one with its submissions table
  const pushLatest = (wizardType: string, row: { completed_at: string | null; updated_at: string | null } | undefined) => {
    if (!row) return
    syntheticEntries.push({ status: 'submitted', current_step: 0, wizard_type: wizardType, updated_at: row.completed_at ?? row.updated_at ?? new Date().toISOString(), data: null })
  }
  pushLatest('itin', (itinRes.data ?? [])[0])
  pushLatest('formation', (formationRes.data ?? [])[0])
  pushLatest('onboarding', (onboardingRes.data ?? [])[0])
  pushLatest('closure', (closureRes.data ?? [])[0])

  // Only add a synthetic entry if wizard_progress doesn't already have a
  // submitted row for that type — wizard_progress wins because it has the
  // actual submitted_data payload for export.
  const existingSubmittedTypes = new Set(
    allWizardEntries.filter(e => e.status === 'submitted').map(e => e.wizard_type),
  )
  for (const s of syntheticEntries) {
    if (!existingSubmittedTypes.has(s.wizard_type)) allWizardEntries.unshift(s)
  }

  // Partner-bank referrals (Model B): banks where clients apply directly via
  // an external link. TD only sees click-through events. Centralised in
  // lib/bank-referrals.ts because the generated Supabase types don't include
  // these tables yet (TS "excessively deep" error otherwise).
  const bankReferrals = await getBankReferralsForAccount(params.id)

  // For backward compat: wizardProgress = the most recent submitted/in_progress wizard
  const wizardProgress = allWizardEntries.length > 0 ? allWizardEntries[0] : null

  // Service deliveries for journey (need stage/pipeline data)
  const serviceDeliveriesRaw = (servicesResult.data ?? []).map(sd => ({
    status: sd.status,
    stage: sd.stage ?? null,
    pipeline: null as string | null,
    service_name: sd.service_name ?? sd.service_type ?? null,
  }))

  // SS-4 applications for this account (EIN pipeline card)
  const { data: ss4Data } = await supabaseAdmin
    .from('ss4_applications')
    .select('id, token, account_id, company_name, status, signed_at, pdf_signed_drive_id')
    .eq('account_id', params.id)
    .order('created_at', { ascending: false })
  const ss4Applications = (ss4Data ?? []) as Array<{
    id: string; token: string; account_id: string; company_name: string
    status: string; signed_at: string | null; pdf_signed_drive_id: string | null
  }>

  // Raw SDs for SS4PipelineCard (needs id, service_type, stage, status, account_id)
  const ss4ServiceDeliveries = (servicesResult.data ?? []).map(sd => ({
    id: sd.id,
    service_type: sd.service_type ?? '',
    stage: sd.stage ?? null,
    status: sd.status,
    account_id: sd.account_id,
  }))

  // SDs for the pipeline stepper section — carries fields the stepper needs
  // (id, stage_order, updated_at) that the legacy `services` mapping strips.
  // The main servicesResult query excludes cancelled SDs (so journey / SS-4 /
  // active counts stay unaffected); fetch cancelled ones separately so the
  // Services tab's "Completed / Cancelled" section can show + reactivate them.
  const { data: cancelledSDsData } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, service_type, stage, stage_order, status, updated_at, account_id, contact_id')
    .eq('account_id', params.id)
    .eq('status', 'cancelled')
    .order('updated_at', { ascending: false })

  const stepperDeliveries = [
    ...(servicesResult.data ?? []).filter(sd => sd.status !== 'cancelled'),
    ...(cancelledSDsData ?? []),
  ].map(sd => ({
    id: sd.id,
    service_type: sd.service_type ?? '',
    service_name: sd.service_name ?? sd.service_type ?? 'Service',
    stage: sd.stage ?? null,
    stage_order: sd.stage_order ?? null,
    status: sd.status ?? 'active',
    updated_at: sd.updated_at ?? new Date().toISOString(),
    account_id: sd.account_id,
    contact_id: sd.contact_id ?? null,
  }))

  // DBA service deliveries (full set, including cancelled — surfaces history
  // even after a DBA is closed). Service type catalog uses literal 'DBA' for
  // doing-business-as filings. We carry stage_order + updated_at so the
  // SdPipelineStepper can be rendered inline per DBA, and join dba_details
  // for the registration-specific fields (jurisdiction, dba_name) keyed by
  // delivery_id.
  const { data: dbaRows } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, stage, stage_order, status, start_date, end_date, notes, updated_at')
    .eq('account_id', params.id)
    .eq('service_type', 'DBA')
    .order('updated_at', { ascending: false })
  const dbaSDIds = (dbaRows ?? []).map(d => d.id)
  type DbaDetailRow = {
    id: string
    delivery_id: string
    dba_name: string
    jurisdiction: string
    filed_date: string | null
    registration_number: string | null
    renewal_date: string | null
    renewal_period: string | null
    filing_fee: number | null
    notes: string | null
    updated_at: string | null
  }
  let dbaDetailsById: Record<string, DbaDetailRow> = {}
  if (dbaSDIds.length > 0) {
    // dba_details is not yet in the generated DB types — cast once here so the
    // call typechecks without leaking `any` into the result rows.
    const untyped = supabaseAdmin as unknown as {
      from: (table: string) => {
        select: (sel: string) => {
          in: (col: string, vals: string[]) => Promise<{ data: Array<DbaDetailRow> | null }>
        }
      }
    }
    const { data: detailsRows } = await untyped
      .from('dba_details')
      .select('id, delivery_id, dba_name, jurisdiction, filed_date, registration_number, renewal_date, renewal_period, filing_fee, notes, updated_at')
      .in('delivery_id', dbaSDIds)
    dbaDetailsById = Object.fromEntries(
      (detailsRows ?? []).map(r => [r.delivery_id, r]),
    )
  }
  const dbaServiceDeliveries = (dbaRows ?? []).map(d => {
    const detail = dbaDetailsById[d.id]
    return {
      id: d.id,
      service_name: d.service_name ?? null,
      stage: d.stage ?? null,
      stage_order: d.stage_order ?? null,
      status: d.status ?? null,
      start_date: d.start_date ?? null,
      end_date: d.end_date ?? null,
      notes: d.notes ?? null,
      updated_at: d.updated_at ?? new Date().toISOString(),
      // dba_details columns (nullable when no detail row exists yet)
      detail_id: detail?.id ?? null,
      detail_updated_at: detail?.updated_at ?? null,
      dba_name: detail?.dba_name ?? d.service_name ?? null,
      jurisdiction: detail?.jurisdiction ?? null,
      filed_date: detail?.filed_date ?? null,
      registration_number: detail?.registration_number ?? null,
      renewal_date: detail?.renewal_date ?? null,
      renewal_period: detail?.renewal_period ?? null,
      filing_fee: detail?.filing_fee ?? null,
      detail_notes: detail?.notes ?? null,
    }
  })

  // Fetch pipeline_stages for every service_type present, in one query.
  // The stepper renders the current → next progression from this set.
  const serviceTypesPresent = Array.from(
    new Set(stepperDeliveries.map(d => d.service_type).filter(Boolean)),
  )
  let stagesByServiceType: Record<string, Array<{ stage_name: string; stage_order: number }>> = {}
  if (serviceTypesPresent.length > 0) {
    const { data: stagesRows } = await supabaseAdmin
      .from('pipeline_stages')
      .select('service_type, stage_name, stage_order')
      .in('service_type', serviceTypesPresent)
      .order('stage_order', { ascending: true })
    const grouped: Record<string, Array<{ stage_name: string; stage_order: number }>> = {}
    for (const row of stagesRows ?? []) {
      const key = row.service_type as string
      if (!grouped[key]) grouped[key] = []
      grouped[key].push({ stage_name: row.stage_name as string, stage_order: row.stage_order as number })
    }
    stagesByServiceType = grouped
  }

  // Service Flow Workspaces — resolve the account's recurring flows (live SDs +
  // date-derived scheduled placeholders for RA/AR). Read-only; additive.
  const flows = await resolveFlows(params.id)

  // Active Company Formation SD → prominent workspace banner near the top.
  // (resolveFlows is account-scoped to the 4 recurring types and excludes
  // Company Formation, so derive it from the loaded SD list directly.)
  const formationSd = (servicesResult.data ?? []).find(
    (sd) => sd.service_type === 'Company Formation' && sd.status === 'active',
  )

  // Active Tax Return SD → the workspace door (card c5ff8b4d Phase 1; Antonio
  // hit this wall in QA: the tax room was unreachable from the account). The
  // workspace is the ONLY staff surface for tax returns, so the way in is a
  // top-of-page banner, exactly like formation's. Year comes from the open
  // return so staff see WHICH year they are about to work on.
  const taxSd = (servicesResult.data ?? []).find(
    (sd) => (sd.service_type === 'Tax Return' || sd.service_type === 'Tax Return Filing') && sd.status === 'active',
  )
  const openTaxYear = ((taxReturnsResult.data ?? []) as Array<{ tax_year: number; data_received: boolean | null }>)
    .filter((tr) => tr.data_received !== true)
    .map((tr) => tr.tax_year)
    .sort((a, b) => b - a)[0] ?? null

  // Primary contact for the e-sign prefill: the resolved signer if the shared
  // resolver found one unambiguously, else the owner-role link (case-insensitive
  // — production holds BOTH 'owner' and 'Owner'), else the first contact in the
  // now-deterministic query order.
  const canViewAs = admin
  const primaryContact =
    resolvedSignerContact ??
    contacts.find((c) => isOwnerRole((c as Contact & { role?: string }).role)) ??
    contacts[0]

  // "View as client" target: ONLY a contact that actually has a client portal
  // login — the button opens that person's portal, so a login is the
  // precondition, not an after-click discovery (Nexo Agency incident,
  // 2026-07-27: the owner-role link had no login and the button always errored).
  // The resolved signer is preferred over account_contacts' free-text role
  // (B&P International incident, 2026-08-20: two co-members were both plain
  // 'Member' in account_contacts with nobody marked owner there, so this fell
  // back to an arbitrary contact-id tiebreak and picked the WRONG person — the
  // one who hadn't finished portal setup — while the actual signer, correctly
  // flagged via `members.is_signer`, was never considered). Preferred among
  // login-holders; button hidden when nobody qualifies. NOTE: this treats "who
  // signs legal documents for this account" and "who staff should view as" as
  // the same person — reasonable (the signer is the account's most
  // authoritative contact) but a real product framing choice, not a fact;
  // worth Antonio's explicit sign-off rather than assuming it.
  //
  // The resolved signer is checked FIRST and directly — NOT by injecting a
  // synthetic 'owner' role into pickViewAsContactId's own search. That was
  // tried and reverted: if a DIFFERENT contact already carries a stale/wrong
  // account_contacts.role='Owner' tag (the resolver exists precisely because
  // that field is unreliable) and also holds a login, pickViewAsContactId's
  // internal "first owner-role match in contact-id order" would coin-flip
  // between the two, silently ignoring which one the resolver actually
  // picked — the same wrong-person failure this fix exists to close, just
  // moved one layer down (senior-engineer confirmation pass, 2026-08-21).
  let viewAsContactId: string | null = null
  if (canViewAs && contacts.length > 0) {
    try {
      const loginHolders = await getClientLoginContactIds()
      if (resolvedSignerContact && loginHolders.has(resolvedSignerContact.id)) {
        viewAsContactId = resolvedSignerContact.id
      } else {
        viewAsContactId = pickViewAsContactId(
          contacts.map((c) => ({ id: c.id, role: (c as Contact & { role?: string }).role })),
          loginHolders,
        )
      }
    } catch (e) {
      // Auth listing failure must not break the account page — just hide the button.
      console.error('[accounts/[id]] view-as target resolution failed:', e)
    }
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-4 flex justify-end gap-2">
        <Link
          href={`/tools/esign/new?account=${params.id}${primaryContact ? `&contact=${primaryContact.id}` : ''}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
        >
          ✍️ Create e-sign document
        </Link>
        {canViewAs && viewAsContactId && <ViewAsClientButton contactId={viewAsContactId} />}
      </div>
      {formationSd && (
        <FormationWorkspaceBanner
          serviceDeliveryId={formationSd.id}
          stage={formationSd.stage}
          companyName={(account as Account).company_name}
        />
      )}
      {taxSd && (
        <TaxWorkspaceBanner
          serviceDeliveryId={taxSd.id}
          stage={taxSd.stage}
          taxYear={openTaxYear}
          companyName={(account as Account).company_name}
        />
      )}
      <AccountDetail
        flows={flows}
        appBaseUrl={APP_BASE_URL}
        account={account as Account}
        contacts={contacts}
        services={services}
        payments={payments}
        deals={deals}
        taxReturns={taxReturns}
        documents={documents}
        today={today}
        isAdmin={admin}
        offer={offer}
        partnerName={partnerName}
        pendingActivation={pendingActivation}
        wizardProgress={wizardProgress}
        serviceDeliveriesRaw={serviceDeliveriesRaw}
        allWizards={allWizardEntries}
        bankReferrals={bankReferrals}
        ss4Applications={ss4Applications}
        ss4ServiceDeliveries={ss4ServiceDeliveries}
        stepperDeliveries={stepperDeliveries}
        stagesByServiceType={stagesByServiceType}
        dbaServiceDeliveries={dbaServiceDeliveries}
      />
    </div>
  )
}
