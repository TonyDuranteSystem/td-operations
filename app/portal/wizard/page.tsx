/**
 * Portal Wizard Page — Data collection inside the portal.
 *
 * Server component that:
 * 1. Gets the logged-in user's account/contact
 * 2. Determines wizard type from service deliveries or offer
 * 3. Loads saved progress from wizard_progress table
 * 4. Renders the appropriate wizard
 */

import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { t, getLocale } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'
import { interpolateString } from '@/lib/template-interpolation'
import { cookies } from 'next/headers'
import { WizardClient } from './wizard-client'
import { isValidWizardType, isContactScopedWizard, isFlexibleWizardType, isPersonOwnedWizard, getContactScopedDiscoveryServiceTypes, type WizardType } from '@/lib/portal/wizard-map'
import { wizardLabelFor } from '@/lib/portal/wizard-labels'
import { getInProgressFormations, getPortalAccounts } from '@/lib/portal/queries'
import { resolveWizardProgressScope } from '@/lib/portal/wizard-scope'
import { getStartAtWizardServiceTypes } from '@/lib/services'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { listQuestions } from '@/lib/td-communication/questions-queries'
import { buildTdCommWizardConfig, type TdCommWizardConfig } from '@/lib/td-communication/question-to-field'
import { isClientEditable, type ReviewStatus } from '@/lib/tax/review-status'
import { identifyFormation, isFormationWizardEditable } from '@/lib/portal/formation-resubmit-gate'
import {
  resolveTaxWizardEligibility,
  taxWizardSurfaceVisible,
  type TaxWizardEligibility,
  type TaxWizardClosedReason,
} from '@/lib/tax/wizard-eligibility'
import { firstYearCoherent } from '@/lib/tax/prior-return-case'
import { resolveExtensionDeadline, formatDeadlineForDisplay } from '@/lib/tax/extension-deadline'
import { TaxExtensionFiledBanner } from '@/components/portal/tax-extension-filed-banner'

export default async function WizardPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; lead?: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">Please log in.</p>
      </div>
    )
  }

  const contactId = getClientContactId(user)
  const locale = getLocale(user)
  const translations = await loadTranslationsForLocale(locale)

  // Get selected account from cookie
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value

  // Get contact details for prefilling
  let contact: Record<string, string> = {}
  if (contactId) {
    const { data: c } = await supabaseAdmin
      .from('contacts')
      .select('full_name, first_name, last_name, email, phone, citizenship, date_of_birth, itin_number, itin_issue_date')
      .eq('id', contactId)
      .single()
    if (c) contact = c as unknown as Record<string, string>
  }

  // Allow explicit type override via ?type= query param (e.g. from tax banner)
  // and ?lead= scope (formation for a NEW company — see formationLeadId below).
  const { type: typeParam, lead: leadParam } = await searchParams
  const forcedType = isValidWizardType(typeParam) ? typeParam : null

  // When the company switcher has an in-progress formation selected (the
  // portal_formation cookie) and no explicit ?lead= or ?type= was passed,
  // resolve that formation's lead so the wizard scopes to the NEW company.
  // Without this, a returning client who also owns an account (e.g. Alessandro
  // Federici: existing Scaledge LLC + new MMLLC) clicks "Complete Your
  // Formation Details" — which links to bare /portal/wizard — and falls through
  // to their account context, opening that account's Tax Return wizard instead
  // of the new company's formation. The ownership check below still applies
  // (the lead comes from getInProgressFormations, which only returns formations
  // for THIS contact), so this never widens access.
  let effectiveLeadParam = leadParam
  if (!effectiveLeadParam && !forcedType && contactId) {
    const cookieFormation = (await cookieStore).get('portal_formation')?.value
    if (cookieFormation) {
      const inProgress = await getInProgressFormations(contactId)
      const selected = inProgress.find(f => f.id === cookieFormation)
      if (selected?.leadId) effectiveLeadParam = selected.leadId
    }
  }

  // ── Formation-for-a-new-company scope ──────────────────────────────────────
  // When ?lead=<lead_id> is present (or resolved from the selected formation
  // above) AND the offer on that lead belongs to this logged-in user, the
  // wizard is for a BRAND NEW company that has no account yet. We must NOT load
  // any existing account (that bug pre-filled THW Global LLC's data for Adam
  // Mihaly). The wizard is scoped to the lead instead. Ownership check: the
  // offer's client_email must match the user/contact email — never trust a raw
  // ?lead= param from the client.
  let formationLeadId: string | null = null
  let formationEntityType: string | null = null
  if (effectiveLeadParam) {
    const ownerEmails = new Set<string>()
    if (user.email) ownerEmails.add(user.email.toLowerCase())
    if (contact.email) ownerEmails.add(String(contact.email).toLowerCase())
    const { data: leadOffer } = await supabaseAdmin
      .from('offers')
      .select('client_email, contract_type, entity_type')
      .eq('lead_id', effectiveLeadParam)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (
      leadOffer?.contract_type === 'formation' &&
      leadOffer.client_email &&
      ownerEmails.has(String(leadOffer.client_email).toLowerCase())
    ) {
      formationLeadId = effectiveLeadParam
      formationEntityType = (leadOffer.entity_type as string | null) ?? null
    }
  }

  // Get account details — SKIPPED when scoped to a formation lead (no account
  // exists yet for the new company).
  let account: Record<string, string> = {}
  // Only trust the portal_account_id cookie for an account the contact ACTUALLY
  // owns. Initializing accountId straight from the cookie let a logged-in contact
  // with NO account_contacts link (an in-progress formation / ITIN-only client)
  // keep a stale cookie's foreign account, so the wizard then resolved its type
  // from THAT account's service deliveries — surfacing the wrong wizard (e.g. a
  // Tax Return SD on an unrelated account → the 4-step tax wizard for a
  // formation/ITIN client who has no tax return). The account must come from a
  // verified link; the cookie only selects AMONG owned accounts. For the
  // (defensive) no-contact case the prior cookie fallback is kept.
  // 2026-06-25 — Daniel Pasztor ITIN/formation wizard mis-resolution.
  let accountId = contactId ? '' : (cookieAccountId || '')
  if (contactId && !formationLeadId) {
    // Default-company rule UNIFIED with the layout/home (2026-07-16, quirk
    // found during the MMLLC E2E walk): this page used to pick the first row
    // of a raw, UNORDERED link query — so a two-company client with no cookie
    // saw the home page scoped to one company and the wizard scoped to the
    // OTHER. getPortalAccounts is the shared list every other surface uses:
    // primary first, then alphabetical, Active/Suspended only.
    const owned = await getPortalAccounts(contactId)
    if (owned.length) {
      const targetId = cookieAccountId && owned.some(a => a.id === cookieAccountId)
        ? cookieAccountId
        : owned[0].id
      accountId = targetId

      const { data: a } = await supabaseAdmin
        .from('accounts')
        .select('company_name, state_of_formation, formation_date, ein_number, filing_id, entity_type, portal_tier')
        .eq('id', targetId)
        .single()
      if (a) account = a as unknown as Record<string, string>
    }
  }

  // Formation lead scope forces a blank formation wizard with no account context.
  if (formationLeadId) {
    accountId = ''
  }

  // ── Tax wizard eligibility (PTBT incident, dev job 8cc8e1c8) ──
  // ONE resolver decides "is the tax wizard open, for which year" for every
  // path through this page — the SD-derived picker, the ?type=tax forced
  // link, AND the offer-fallback. Memoized so the page hits the DB once.
  let taxGateMemo: TaxWizardEligibility | null = null
  const getTaxGate = async (): Promise<TaxWizardEligibility> => {
    if (!taxGateMemo) taxGateMemo = await resolveTaxWizardEligibility({ accountId, contactId })
    return taxGateMemo
  }

  // Determine wizard type from offer or service deliveries
  let wizardType: WizardType = forcedType || (formationLeadId ? 'formation' : 'onboarding')
  let entityType = account.entity_type || formationEntityType || 'SMLLC'
  let isItinRenewal = false

  // Collect ALL pending wizard types from service deliveries
  // `label` / `labelIt` come from lib/portal/wizard-labels (the shared client
  // vocabulary) so this tab strip says the same thing as the home card that
  // links here. They were hardcoded and English-only: a client clicked
  // "Complete your Payset Bank Account form" and landed on a tab reading
  // "Payset (EUR)", in English even with the portal set to Italian.
  const pendingWizardTypes: { type: WizardType; label: string; labelIt: string; serviceType: string }[] = []
  const wizardLabels = (t: WizardType, serviceType?: string) => ({
    label: wizardLabelFor(t, serviceType).en,
    labelIt: wizardLabelFor(t, serviceType).it,
  })

  if (!forcedType && !formationLeadId && (accountId || contactId)) {
    // Look up service deliveries by account_id OR contact_id (formation clients have no account yet)
    const sdQuery = accountId
      ? supabaseAdmin.from('service_deliveries').select('service_type, stage').eq('account_id', accountId).in('status', ['active']).limit(10)
      : supabaseAdmin.from('service_deliveries').select('service_type, stage').eq('contact_id', contactId).in('status', ['active']).limit(10)

    const { data: primarySds } = await sdQuery

    // Contact-scoped union: when the client has an account AND a contactId,
    // ALSO look up contact-scoped SDs — flexible types (Closure) and
    // person-owned types (ITIN, which is ALWAYS contact-scoped).
    // Without this, a managed-account holder closing an EXTERNAL LLC (SD on
    // contact_id only, account_id NULL) is invisible because the primary
    // query above only sees account-scoped SDs — and so is the ITIN of anyone
    // who already owns a company (Pietro De Pellegrino, 2026-07-21).
    let flexibleSds: Array<{ service_type: string; stage: string | null }> = []
    if (accountId && contactId) {
      const flexibleTypes = getContactScopedDiscoveryServiceTypes()
      if (flexibleTypes.length > 0) {
        const { data: flex } = await supabaseAdmin
          .from('service_deliveries')
          .select('service_type, stage')
          .eq('contact_id', contactId)
          .is('account_id', null)
          .in('status', ['active'])
          .in('service_type', flexibleTypes)
          .limit(10)
        flexibleSds = flex || []
      }
    }

    const sds = [...(primarySds || []), ...flexibleSds]
    const types = sds.map(s => s.service_type)

    // Check which wizard types have already been submitted.
    // Account-owned wizards are read by account_id. Contact-owned wizards
    // (formation) live on the contact and never carry an account_id, so they
    // are read by contact_id — but only contact-scoped types are taken from
    // that query, so a submission for one account never masks another account's
    // pending wizard. See dev_task 21fd1f4a.
    const submittedTypes = new Set<string>()
    if (accountId) {
      const { data: byAccount } = await supabaseAdmin
        .from('wizard_progress')
        .select('wizard_type')
        .eq('account_id', accountId)
        .in('status', ['submitted'])
      for (const w of byAccount || []) submittedTypes.add(w.wizard_type)
    }
    if (contactId) {
      const { data: byContact } = await supabaseAdmin
        .from('wizard_progress')
        .select('wizard_type')
        .eq('contact_id', contactId)
        .in('status', ['submitted'])
      for (const w of byContact || []) {
        if (
          isContactScopedWizard(w.wizard_type) ||
          isFlexibleWizardType(w.wizard_type) ||
          isPersonOwnedWizard(w.wizard_type)
        ) submittedTypes.add(w.wizard_type)
      }
    }

    // Build list of ALL applicable wizard types (both pending and submitted)
    if (types.includes('Company Formation')) {
      pendingWizardTypes.push({ type: 'formation', ...wizardLabels('formation'), serviceType: 'Company Formation' })
    }
    if (types.includes('Banking Fintech')) {
      pendingWizardTypes.push({ type: 'banking_payset', ...wizardLabels('banking_payset'), serviceType: 'Banking Fintech' })
      pendingWizardTypes.push({ type: 'banking_relay', ...wizardLabels('banking_relay'), serviceType: 'Banking Fintech' })
    }
    if (types.includes('Company Closure')) {
      pendingWizardTypes.push({ type: 'closure', ...wizardLabels('closure'), serviceType: 'Company Closure' })
    }
    if (types.includes('ITIN Renewal')) {
      // Renewal label comes from the shared SERVICE_LABEL_OVERRIDES so this tab
      // and the home card that links to it cannot disagree — they did: the card
      // said "ITIN Application" while this tab said "ITIN Renewal".
      pendingWizardTypes.push({ type: 'itin', ...wizardLabels('itin', 'ITIN Renewal'), serviceType: 'ITIN Renewal' })
      isItinRenewal = true
    } else if (types.includes('ITIN')) {
      pendingWizardTypes.push({ type: 'itin', ...wizardLabels('itin'), serviceType: 'ITIN' })
    }
    if (types.includes('Tax Return') || types.includes('Tax Return One-Time')) {
      // Eligibility comes from the shared resolver (lib/tax/wizard-eligibility):
      // open tax_returns row + formation-year guard + named stage allow-list,
      // fail-closed. The old inline PRE_WIZARD_STAGES deny-list lived only on
      // this path and let unknown stages — and every ?type=tax link — through.
      const taxReturnSd = (sds || []).find(s =>
        s.service_type === 'Tax Return' || s.service_type === 'Tax Return One-Time',
      )
      const serviceType = taxReturnSd?.service_type === 'Tax Return One-Time' ? 'Tax Return One-Time' : 'Tax Return'
      const gate = await getTaxGate()
      if (gate.mode === 'company_info') {
        pendingWizardTypes.push({ type: 'company_info', ...wizardLabels('company_info'), serviceType })
      } else if (taxWizardSurfaceVisible(gate)) {
        // open / review / review-LOCKED (under_review, confirmed): the locked
        // states keep the tab so the client can still VIEW their submitted
        // data read-only (isLocked below) — only submitting is gated.
        pendingWizardTypes.push({ type: 'tax', ...wizardLabels('tax'), serviceType })
      }
      // otherwise closed → no tax tab: nothing to collect (pre-wizard stage,
      // no open season, or no filing requirement).
    }

    // If only one pending wizard, use it directly
    if (pendingWizardTypes.length === 1) {
      wizardType = pendingWizardTypes[0].type
      if (pendingWizardTypes[0].type === 'itin' && types.includes('ITIN Renewal')) isItinRenewal = true
    } else if (pendingWizardTypes.length > 1) {
      // Multiple wizards — filter out already-submitted ones for auto-selection
      const unsubmitted = pendingWizardTypes.filter(w => !submittedTypes.has(w.type))
      if (unsubmitted.length === 1) {
        // Only one unsubmitted — go directly to it
        wizardType = unsubmitted[0].type
      } else if (unsubmitted.length > 1) {
        // Multiple unsubmitted — pick first one as default but we'll show selection
        wizardType = unsubmitted[0].type
      } else {
        // All submitted — show the first one for review
        wizardType = pendingWizardTypes[0].type
      }
    }
  }

  // Also check via lead/offer (for leads without account, skip if type was forced)
  if (!forcedType && wizardType === 'onboarding') {
    // Collect all emails to search
    const searchEmails = new Set<string>()
    if (user.email) searchEmails.add(user.email)
    if (contact.email) searchEmails.add(contact.email)
    const emailArr = Array.from(searchEmails)

    if (emailArr.length > 0) {
      // Try to find lead by email
      const { data: leads } = await supabaseAdmin
        .from('leads')
        .select('id')
        .in('email', emailArr)
        .limit(1)

      const leadId = leads?.[0]?.id
      if (leadId) {
        const { data: offer } = await supabaseAdmin
          .from('offers')
          .select('contract_type, bundled_pipelines')
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (offer?.contract_type) {
          if (offer.contract_type === 'formation') wizardType = 'formation'
          else if (offer.contract_type === 'tax_return') wizardType = 'tax'
          else if (offer.contract_type === 'itin') wizardType = 'itin'
        }
      }

      // Also try directly via offer client_email
      if (wizardType === 'onboarding') {
        const { data: directOffer } = await supabaseAdmin
          .from('offers')
          .select('contract_type')
          .in('client_email', emailArr)
          .not('status', 'eq', 'expired')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (directOffer?.contract_type === 'formation') wizardType = 'formation'
        else if (directOffer?.contract_type === 'tax_return') wizardType = 'tax'
        else if (directOffer?.contract_type === 'itin') wizardType = 'itin'
      }
    }
  }

  // ── TAX WIZARD FINAL GATE — covers ?type=tax AND the offer-fallback path ──
  // The derived picker above already consulted the resolver, but a forced
  // ?type=tax link (home card, tax banner, financials-review Edit) and the
  // offer-fallback both bypass that block entirely — exactly how PTBT reached
  // a wizard whose SD sat at a pre-wizard stage. Locked review states still
  // render (read-only); genuinely-closed states get the friendly card below.
  let taxClosedNotice: TaxWizardClosedReason | null = null
  let pinnedTaxYear: number | null = null
  if (wizardType === 'tax') {
    const gate = await getTaxGate()
    if (gate.mode === 'company_info') {
      wizardType = 'company_info'
    } else if (!taxWizardSurfaceVisible(gate)) {
      taxClosedNotice = gate.reason ?? 'no_tax_return_open'
    } else {
      pinnedTaxYear = gate.taxYear
    }
  }
  if (taxClosedNotice) {
    // CLOSED_REASON_COPY (lib/tax/wizard-eligibility.ts) still holds the
    // .en/.it pairs — it's ALSO used by wizard-submit's error responses,
    // which are out of scope here. This page's own render goes through the
    // shared dictionary instead, keyed to the same reason names, so it picks
    // up a third language; the reason→key map below IS the translation.
    const closedReasonKeys: Record<TaxWizardClosedReason, string> = {
      no_tax_service: 'taxClosed.noTaxService',
      no_tax_return_open: 'taxClosed.noTaxReturnOpen',
      pre_wizard_stage: 'taxClosed.preWizardStage',
      formation_after_tax_year: 'taxClosed.formationAfterTaxYear',
      under_review: 'taxClosed.underReview',
      confirmed: 'taxClosed.confirmed',
    }
    return (
      <div className="px-4 py-6 lg:px-8">
        <div className="mx-auto max-w-xl rounded-xl border border-zinc-200 bg-white p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-2xl">🗓️</div>
          <h2 className="mb-2 text-lg font-semibold text-zinc-900">
            {t('wizard.taxQuestionnaireUnavailable', locale, translations)}
          </h2>
          <p className="text-sm text-zinc-600">{t(closedReasonKeys[taxClosedNotice], locale, translations)}</p>
          <a href="/portal" className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            {t('wizard.backToPortal', locale, translations)}
          </a>
        </div>
      </div>
    )
  }

  // A formation is for a NEW company — it must never bind to or pre-fill an
  // EXISTING account. When the wizard resolves to formation without a ?lead=
  // scope (e.g. an existing client reached it via a link that dropped the
  // lead param), drop the existing-account context so we don't pre-fill the
  // old company's name/EIN/state and so submission stays contact+lead scoped.
  // This is the page-side half of the THW Global hijack fix (Adam Mihaly,
  // 2026-05-20, dev_task 358e8cbe); the server backstop is in wizard-submit.
  if (wizardType === 'formation' && !formationLeadId) {
    accountId = ''
    account = {}
  }

  // ── Formation entity type: the signed CONTRACT decides, never a code default ──
  // Placement is load-bearing. It sits AFTER wizardType is final (the SD picker
  // and the offer fallback above can still change it) and AFTER the account is
  // dropped at :417-420, and it must run BEFORE normalizeEntityType below —
  // that helper returns 'SMLLC' for any falsy input, which would silently
  // re-introduce the very default this block removes.
  //
  // Why account.entity_type is IGNORED here: a formation is a NEW company. A
  // returning client who already owns an SMLLC and is now forming an MMLLC had
  // the OLD company's type decide the NEW company's form (line 182) — the form
  // rendered single-member, the members step never appeared, and the ITIN
  // requirement became unsatisfiable. That is the Alessandro Della Bianca /
  // Alessandro Federici defect (dev job fc69557f); the render-side default has
  // been present since the wizard's first commit, 2026-03-21.
  //
  // Sources, in order:
  //   1. signed contract  — resolveEntityTypeForFormation (contracts.llc_type).
  //                         Antonio, 2026-06-11: "The CRM must be set according
  //                         to the contract that the client signed."
  //   2. offers.entity_type — what was sold, and the field staff edit to
  //                         override BEFORE the client opens the form.
  //   3. UNRESOLVED       — ask the client one plain question in the wizard.
  //                         NEVER guess (Antonio, 2026-08-09: a hard wall
  //                         "recreates the dead end this whole job exists to
  //                         fix, and it would hit returning clients hardest").
  let entityUnresolved = false
  if (wizardType === 'formation') {
    const { resolveEntityTypeForFormation, normalizeEntityCode } = await import(
      '@/lib/portal/entity-type-from-contract'
    )

    let code: 'SMLLC' | 'MMLLC' | null = null
    // A Corporation is neither SMLLC nor MMLLC. There is no Corp branch in the
    // formation wizard config, so a Corporation has always rendered the
    // single-owner form and been finished by hand (activate-service routes it
    // to manual handling). That is unchanged here — but it must NOT reach the
    // ownership question below, because "just me / me and other owners" is a
    // nonsense question for a corporation and its answer would be written to
    // the submission as SMLLC/MMLLC.
    let isCorporation = false
    if (contactId) {
      const resolution = await resolveEntityTypeForFormation({
        contactId,
        leadId: formationLeadId,
      })
      code = resolution.wizardCode
      if (resolution.source === 'corporation_manual') {
        isCorporation = true
        console.warn('[wizard] formation resolved to Corporation — manual handling', resolution.detail)
      }
    }

    // 2. The offer — what was sold. `formationEntityType` is only populated on
    //    the ?lead= path (:107-126); every other entry point — the formation
    //    dashboard button, the services page ?type=formation link, the
    //    post-payment portal notification, the reminder cron — arrives without
    //    it, which is why this lookup is repeated here rather than reused.
    //
    //    NOTE ON PRECEDENCE: this sits BELOW the signed contract, so editing an
    //    offer does NOT override a contract that already says something else.
    //    Staff overriding a *wrong* signed contract still has to go through the
    //    Articles-upload override at materialization time. Flagged to Antonio
    //    2026-08-09; changing it needs somewhere to store an override that
    //    outranks a signed contract, which is a schema change.
    if (!code && !isCorporation) {
      const offerEmails = new Set<string>()
      if (user.email) offerEmails.add(user.email.toLowerCase())
      if (contact.email) offerEmails.add(String(contact.email).toLowerCase())
      let offerEntity: string | null = normalizeEntityCode(formationEntityType)
      if (!offerEntity && offerEmails.size > 0) {
        // contract_type is filtered so a newer tax/renewal offer to the same
        // address cannot answer a question about the formation. status is
        // filtered so a superseded draft or an expired offer cannot outrank the
        // live one — the sibling fallback further up this file guards the same
        // way, and duplicated/expired offers are normal in this CRM.
        // Case-INSENSITIVE. offers.client_email is stored verbatim as typed —
        // nothing normalizes it on the create path — so an `.in()` against
        // pre-lowercased values silently misses "Mario.Rossi@gmail.com" and the
        // client gets asked a question their offer already answered. The
        // sibling lookup earlier in this file compares lowercased on both sides
        // for the same reason.
        const emailOr = Array.from(offerEmails)
          .map(e => `client_email.ilike.${e}`)
          .join(',')
        const { data: offerRows } = await supabaseAdmin
          .from('offers')
          .select('entity_type, created_at')
          .or(emailOr)
          .eq('contract_type', 'formation')
          .in('status', ['sent', 'viewed', 'signed', 'completed'])
          .not('entity_type', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
        offerEntity = normalizeEntityCode(offerRows?.[0]?.entity_type ?? null)
      }
      code = offerEntity as 'SMLLC' | 'MMLLC' | null
    }

    if (code) entityType = code
    else if (!isCorporation) entityUnresolved = true
  }

  // Load saved progress — include 'submitted' so clients can edit before review
  let savedData: Record<string, unknown> = {}
  let savedStep = 0
  let progressId: string | null = null
  let wizardSubmitStatus: 'in_progress' | 'submitted' | null = null

  // Resolve which column to scope the lookup on (see resolveWizardProgressScope
  // for the precedence + the lead_id-null disambiguation). Building the query
  // dynamically over a union of columns trips TS's type-instantiation depth
  // (TS2589) on the typed builder, so the builder is cast to any.
  const progressScope = resolveWizardProgressScope({ wizardType, formationLeadId, accountId, contactId })

  const progressQuery = progressScope
    ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic scope column over a union trips TS2589 on the typed builder
        let q = (supabaseAdmin as any)
          .from('wizard_progress')
          .select('*')
          .eq(progressScope.col, progressScope.val)
          .eq('wizard_type', wizardType)
          .in('status', ['in_progress', 'submitted'])
        if (progressScope.restrictToNoLead) q = q.is('lead_id', null)
        return q.order('updated_at', { ascending: false }).limit(1).maybeSingle()
      })()
    : null

  if (progressQuery) {
    const { data: progress } = await progressQuery
    if (progress) {
      savedData = (progress.data as Record<string, unknown>) || {}
      // Cap current_step (submitted records may have step=99)
      savedStep = Math.min(progress.current_step || 0, 20)
      progressId = progress.id
      wizardSubmitStatus = progress.status as 'in_progress' | 'submitted'
    }
  }

  // Edit-mode pre-fill for tax clients who submitted through the EXTERNAL form
  // (Carasso edit-button fix, 2026-07-23). Those clients have NO wizard_progress
  // row — their answers and uploaded documents live only on the submission. When
  // staff reopen for changes and the client edits, his data must ALREADY be on
  // the form (so a wrong figure or a wrong document is right there to correct),
  // not a blank form. Only fires for tax, only when there's no draft to prefer,
  // and only while the review state is client-editable — never overrides an
  // in-progress draft, never surfaces a locked/under-review submission.
  if (wizardType === 'tax' && accountId && !progressId) {
    const { data: editSub } = await supabaseAdmin
      .from('tax_return_submissions')
      .select('submitted_data, review_status')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const rs = (editSub?.review_status ?? null) as ReviewStatus | null
    if (editSub?.submitted_data && rs !== null && isClientEditable(rs)) {
      savedData = editSub.submitted_data as Record<string, unknown>
      // Start at step 1 so he walks every step — any NEW required question the
      // form has gained since his submission is shown blank, not skipped.
      savedStep = 0
      wizardSubmitStatus = 'submitted'
    }
  }

  // For submitted tax wizards: lock based on the REVIEW state (Slice 2), not the
  // old sent_to_accountant flag. Editable while submitted / revision_requested /
  // approved / reopened; LOCKED while staff are actively reviewing (under_review)
  // or after the client has confirmed (confirmed).
  let isLocked = false
  if (wizardSubmitStatus === 'submitted' && wizardType === 'tax' && accountId) {
    const { data: sub } = await supabaseAdmin
      .from('tax_return_submissions')
      .select('review_status')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const rs = (sub?.review_status ?? null) as ReviewStatus | null
    isLocked = rs !== null && !isClientEditable(rs)
  }

  // For submitted FORMATION wizards: the same idea, keyed on how far the
  // formation itself has got (dev job ca788354, Antonio's ruling 2026-08-10).
  // Editable until we begin work — a client fixing a wrong passport or date
  // before we file is deliberately kept open — and locked from "Filed with
  // State" onward, once the company has materialized, or once it is finished.
  //
  // Until this shipped, `isLocked` was computed for tax ONLY, so a submitted
  // formation was permanently editable and the portal sent `allow_resubmit` on
  // every re-submit, bypassing the server's duplicate check entirely. That is
  // how 8 clients re-ran the setup chain 15 times.
  //
  // Identification uses the SAME helper as the background job, so a repeat
  // client's two formations can never be resolved differently by the two — the
  // one that would lock company two because company one has been filed.
  if (wizardSubmitStatus === 'submitted' && wizardType === 'formation' && contactId) {
    let formationOfferToken: string | null = null
    if (formationLeadId) {
      const { data: offerRow } = await supabaseAdmin
        .from('offers')
        .select('token')
        .eq('lead_id', formationLeadId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      formationOfferToken = (offerRow?.token as string | null) ?? null
    }

    const { data: sdRows, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, stage, status, account_id, source_offer_token')
      .eq('contact_id', contactId)
      .eq('service_type', 'Company Formation')
      .limit(50)

    if (sdErr) {
      // Cannot prove the formation is still editable — lock rather than risk
      // an overwrite of live company data. The locked view points to chat.
      isLocked = true
    } else {
      const found = identifyFormation(
        formationOfferToken,
        (sdRows ?? []).map((r) => ({
          id: String(r.id),
          stage: (r.stage as string | null) ?? null,
          status: (r.status as string | null) ?? null,
          hasAccount: r.account_id != null,
          sourceOfferToken: (r.source_offer_token as string | null) ?? null,
        })),
      )
      isLocked = !isFormationWizardEditable(found.formation, found.ambiguous)
    }
  }

  // ── ITIN applicants (dev_task fcf5e254) ──
  // When the formation/onboarding offer bundled ITIN (a start-at-wizard
  // service), the wizard asks the client WHO applies. itinCount = how many
  // ITINs were purchased; the client must mark exactly that many people.
  let itinCount = 0
  if (wizardType === 'formation' || wizardType === 'onboarding') {
    const startAtWizard = await getStartAtWizardServiceTypes()
    if (startAtWizard.includes('ITIN')) {
      const offerEmails = new Set<string>()
      if (user.email) offerEmails.add(user.email)
      if (contact.email) offerEmails.add(String(contact.email))
      let offerRow: { services: unknown; bundled_pipelines: string[] | null } | null = null
      if (formationLeadId) {
        const { data } = await supabaseAdmin
          .from('offers')
          .select('services, bundled_pipelines')
          .eq('lead_id', formationLeadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        offerRow = data as typeof offerRow
      }
      if (!offerRow && offerEmails.size > 0) {
        const { data } = await supabaseAdmin
          .from('offers')
          .select('services, bundled_pipelines')
          .in('client_email', Array.from(offerEmails))
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        offerRow = data as typeof offerRow
      }
      if (offerRow) {
        const services = Array.isArray(offerRow.services)
          ? (offerRow.services as Array<Record<string, unknown>>)
          : []
        const itinSvc = services.find((s) => s.pipeline_type === 'ITIN')
        if (itinSvc && typeof itinSvc.quantity === 'number' && itinSvc.quantity > 0) {
          itinCount = itinSvc.quantity
        } else if (Array.isArray(offerRow.bundled_pipelines)) {
          itinCount = offerRow.bundled_pipelines.filter((p) => p === 'ITIN').length
        }
      }
    }
  }

  // Build prefill data from contact + account
  const prefillData: Record<string, string> = {}
  if (contact.first_name) prefillData.owner_first_name = contact.first_name
  if (contact.last_name) prefillData.owner_last_name = contact.last_name
  if (contact.email) prefillData.owner_email = contact.email
  if (contact.phone) prefillData.owner_phone = contact.phone
  if (contact.date_of_birth) prefillData.owner_dob = contact.date_of_birth
  if (contact.citizenship) { prefillData.owner_nationality = contact.citizenship; prefillData.owner_tax_residency = contact.citizenship }
  if (contact.itin_number) prefillData.owner_itin = contact.itin_number
  if (contact.itin_issue_date) prefillData.owner_itin_issue_date = contact.itin_issue_date
  // Banking-specific prefills
  if (contact.first_name) prefillData.first_name = contact.first_name
  if (contact.last_name) prefillData.last_name = contact.last_name
  if (contact.email) { prefillData.email = contact.email; prefillData.personal_email = contact.email }
  if (contact.phone) { prefillData.phone = contact.phone; prefillData.personal_phone = contact.phone }
  if (contact.citizenship) prefillData.personal_country = contact.citizenship
  if (account.company_name) { prefillData.business_name = account.company_name; prefillData.company_name = account.company_name; prefillData.llc_name = account.company_name }
  if (account.ein_number) { prefillData.ein = account.ein_number; prefillData.llc_ein = account.ein_number; prefillData.ein_number = account.ein_number }
  if (account.state_of_formation) { prefillData.state_of_formation = account.state_of_formation; prefillData.state_of_incorporation = account.state_of_formation }
  if (account.formation_date) { prefillData.formation_date = account.formation_date; prefillData.date_of_incorporation = account.formation_date }
  if (account.filing_id) prefillData.filing_id = account.filing_id

  // ITIN Renewal: pre-fill previous ITIN from contact
  if (isItinRenewal && contact.itin_number) {
    prefillData.has_previous_itin = 'Yes'
    prefillData.previous_itin = contact.itin_number
  }

  // Tax wizard — prior-return matrix Case A (master plan §5): when WE filed
  // the prior-year return ('TR Filed' on record), preselect "Tony Durante
  // filed it for us" so the client doesn't have to know or upload anything.
  // The submit route re-verifies the claim regardless of this preselection.
  if (wizardType === 'tax' && accountId) {
    try {
      const { data: pendingTr } = await supabaseAdmin
        .from('tax_returns')
        .select('tax_year')
        .eq('account_id', accountId)
        .eq('data_received', false)
        .order('tax_year', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (pendingTr?.tax_year) {
        const { data: priorFiled } = await supabaseAdmin
          .from('tax_returns')
          .select('id')
          .eq('account_id', accountId)
          .eq('tax_year', pendingTr.tax_year - 1)
          .eq('status', 'TR Filed')
          .limit(1)
          .maybeSingle()
        if (priorFiled) {
          prefillData.prior_return_case = 'we_filed'
        } else if (account.formation_date && firstYearCoherent(account.formation_date, pendingTr.tax_year) === true) {
          // First-year preselect: a company formed within (or after) the filing
          // year has no prior return — preselect "first year" so the client
          // doesn't answer a question with one possible answer. The submit route
          // re-cross-checks formation_date regardless (firstYearCoherent).
          prefillData.prior_return_case = 'first_year'
        }
      }
    } catch (e) {
      console.error('[wizard] Prior-return Case A prefill failed (non-blocking):', e)
    }

    // Members pre-fill (§14 redesign — "confirm, don't type"): every contact
    // linked to the account becomes a pre-filled member card; the client
    // confirms or corrects instead of retyping data we already hold.
    try {
      const { data: links } = await supabaseAdmin
        .from('account_contacts')
        .select('ownership_pct, contacts(first_name, last_name, citizenship, itin_number, address_line1, address_city, address_zip, address_country)')
        .eq('account_id', accountId)
      const members = ((links ?? []) as unknown as Array<{
        ownership_pct: number | null
        contacts: { first_name: string | null; last_name: string | null; citizenship: string | null; itin_number: string | null; address_line1: string | null; address_city: string | null; address_zip: string | null; address_country: string | null } | null
      }>).filter(l => l.contacts && (l.contacts.first_name || l.contacts.last_name))
      if (members.length > 0) {
        prefillData.member_count = String(members.length)
        members.forEach((m, i) => {
          const c = m.contacts!
          prefillData[`member_${i}_member_type`] = 'individual'
          if (c.first_name) prefillData[`member_${i}_member_first_name`] = c.first_name
          if (c.last_name) prefillData[`member_${i}_member_last_name`] = c.last_name
          if (c.citizenship) prefillData[`member_${i}_member_citizenship`] = c.citizenship
          if (c.address_country) prefillData[`member_${i}_member_residence_country`] = c.address_country
          if (c.address_line1) prefillData[`member_${i}_member_street`] = c.address_line1
          if (c.address_city) prefillData[`member_${i}_member_city`] = c.address_city
          if (c.address_zip) prefillData[`member_${i}_member_zip`] = c.address_zip
          if (c.itin_number) {
            prefillData[`member_${i}_member_itin_status`] = 'has_itin'
            prefillData[`member_${i}_member_itin`] = c.itin_number
          }
          if (m.ownership_pct !== null) prefillData[`member_${i}_member_ownership_pct`] = String(m.ownership_pct)
        })
      }
    } catch (e) {
      console.error('[wizard] Members prefill failed (non-blocking):', e)
    }
  }

  // Bank CSV-export guides (catalog 'bank_export_guides', §3.1/§8): shown
  // under each bank upload card when the typed bank name matches. Staff
  // add/edit banks in the catalog — no deploy. Failure = no guides, never
  // a blocked wizard.
  let bankGuides: Array<{ name: string; matchTerms: string[]; stepsEn: string[]; stepsIt: string[]; noteEn: string; noteIt: string }> = []
  if (wizardType === 'tax') {
    try {
      const { data: guideRows } = await supabaseAdmin
        .from('catalog_entries')
        .select('display_name, metadata')
        .eq('catalog_id', 'bank_export_guides')
        .eq('status', 'active')
      bankGuides = (guideRows ?? []).map(r => {
        const m = (r.metadata ?? {}) as Record<string, unknown>
        const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
        return {
          name: r.display_name,
          matchTerms: arr(m.match_terms),
          stepsEn: arr(m.steps_en),
          stepsIt: arr(m.steps_it),
          noteEn: typeof m.note_en === 'string' ? m.note_en : '',
          noteIt: typeof m.note_it === 'string' ? m.note_it : '',
        }
      }).filter(g => g.matchTerms.length > 0 && g.stepsEn.length > 0)
    } catch (e) {
      console.error('[wizard] Bank guides load failed (non-blocking):', e)
    }
  }

  // Identity build (2026-08-13, card 4a39e0fd): the LIVE institution registry
  // (catalog merged over the code seed) rides to the client so each bank row
  // resolves its IDENTITY MODE — banks require the account number, Wise-style
  // services and crypto never ask. Failure = seed-only registry via the
  // loader's own fallback, never a blocked wizard.
  let institutions: Array<{ canonical: string; mode: 'account_number' | 'currency' | 'crypto'; matchTerms: string[] }> = []
  if (wizardType === 'tax') {
    try {
      const { loadInstitutionRegistry } = await import('@/lib/tax/institution-registry')
      institutions = (await loadInstitutionRegistry()).map(e => ({
        canonical: e.canonical, mode: e.mode, matchTerms: e.matchTerms,
      }))
    } catch (e) {
      console.error('[wizard] Institution registry load failed (non-blocking):', e)
    }
  }

  // Normalize entity type so the wizard config turns on the right steps. The
  // MMLLC "add members" step only renders for 'MMLLC'; the stored value is
  // "Multi Member LLC" (space), which the old exact-string check missed —
  // breaking member-add for every multi-member client. See normalizeEntityType.
  // Skipped when the formation entity type is genuinely unresolved: this helper
  // returns 'SMLLC' for any falsy input (lib/portal/entity-type.ts), so calling
  // it here would convert "we don't know" back into "single member" — the exact
  // silent default the block above exists to remove. The client is asked
  // instead; WizardClient renders the question when entityUnresolved is true.
  if (!entityUnresolved) entityType = normalizeEntityType(entityType)

  // TD Communication brand audit: the client_type ('new_brand' | 'rebrand') is
  // chosen by the client's active enrollment. Resolve it by the WHOLE identity
  // (contact OR any owned account) and pass it through as entityType. The
  // wizard's questions come from the DB (td_comm_questions) — built here into a
  // configOverride and prop-drilled to WizardClient. Falls back to the code-side
  // placeholder config when the DB has no active questions (direct-URL / not-yet
  // -seeded safety). Defaults to new_brand when no enrollment is found.
  let tdCommConfigOverride: TdCommWizardConfig | undefined
  if (wizardType === 'td_communication') {
    const ownedAccountIds: string[] = []
    if (accountId) ownedAccountIds.push(accountId)
    if (contactId) {
      const { data: acLinks } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id')
        .eq('contact_id', contactId)
      for (const l of acLinks ?? []) {
        if (l.account_id && !ownedAccountIds.includes(l.account_id)) ownedAccountIds.push(l.account_id)
      }
    }
    const { getClientActiveEnrollment } = await import('@/lib/td-communication/brand-audit')
    const enrollment = await getClientActiveEnrollment(contactId || null, ownedAccountIds)
    entityType = enrollment?.client_type === 'rebrand' ? 'rebrand' : 'new_brand'

    try {
      const allQuestions = await listQuestions()
      const built = buildTdCommWizardConfig(allQuestions, entityType === 'rebrand' ? 'rebrand' : 'new_brand')
      if (built.steps.length > 0) tdCommConfigOverride = built
    } catch (err) {
      console.error('[wizard] td_communication question load failed — falling back to code config', err)
    }
  }

  // Build wizard list with submission status for the selector
  // Query all wizard progress for this account to know which are submitted
  let allSubmittedTypes = new Set<string>()
  if (accountId && pendingWizardTypes.length > 1) {
    const { data: allProgress } = await supabaseAdmin
      .from('wizard_progress')
      .select('wizard_type, status')
      .eq('account_id', accountId)
      .eq('status', 'submitted')
    allSubmittedTypes = new Set((allProgress || []).map(p => p.wizard_type))
  }
  const wizardList = pendingWizardTypes.map(w => ({
    ...w,
    submitted: allSubmittedTypes.has(w.type),
  }))

  // Tax season pause gate — only block the wizard when THIS account's Tax
  // Return SD is actually on_hold. The global tax_season_paused flag drives
  // parking policy at SD creation (activate-service + installment-handler),
  // not UI gating — One-Time standalone Tax Return clients are exempt from
  // parking and must retain access to their wizards even while the flag is
  // set.
  let taxPauseBanner: ReactNode = null
  if (wizardType === 'tax' || wizardType === 'company_info') {
    let sdOnHold = false
    if (accountId) {
      const { data: trSd } = await supabaseAdmin
        .from('service_deliveries')
        .select('status')
        .eq('account_id', accountId)
        .eq('service_type', 'Tax Return')
        .not('status', 'in', '(completed,cancelled)')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      sdOnHold = trSd?.status === 'on_hold'
    } else if (contactId) {
      // Standalone business TR clients (Marvin-style): SD is attached to
      // contact_id, account_id=null until they submit company_info wizard.
      const { data: trSd } = await supabaseAdmin
        .from('service_deliveries')
        .select('status')
        .eq('contact_id', contactId)
        .eq('service_type', 'Tax Return')
        .is('account_id', null)
        .not('status', 'in', '(completed,cancelled)')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      sdOnHold = trSd?.status === 'on_hold'
    }
    if (sdOnHold) {
      // Look up the matching tax_returns row for banner props. We match on
      // company_name the same way getPortalTaxReturns does — accountId here
      // may be empty for pre-account tax leads, in which case we render with
      // null fields and the banner's graceful fallbacks kick in.
      const firstName = (user.user_metadata?.full_name as string | undefined)?.split(' ')[0] ?? (contact.first_name as string | undefined) ?? null
      let confirmationId: string | null = null
      let deadlineIso: string | null = null
      let returnType: 'SMLLC' | 'MMLLC' | 'Corp' | 'S-Corp' | null = null
      let taxYear: number | null = null
      let trStatus: string | null = null
      if (account.company_name) {
        const { data: tr } = await supabaseAdmin
          .from('tax_returns')
          .select('extension_submission_id, extension_deadline, tax_year, return_type, status')
          .eq('company_name', account.company_name)
          .order('tax_year', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (tr) {
          confirmationId = (tr.extension_submission_id as string | null) ?? null
          deadlineIso = (tr.extension_deadline as string | null) ?? null
          const rt = tr.return_type as string | null
          returnType = rt === 'SMLLC' || rt === 'MMLLC' || rt === 'Corp' || rt === 'S-Corp' ? rt : null
          taxYear = (tr.tax_year as number | null) ?? null
          trStatus = (tr.status as string | null) ?? null
        }
      }
      // Defense in depth: if the tax_returns row is already past the data-
      // receipt stage, don't render the pause banner — the wizard gate
      // should unblock so the client can still reach their data. This
      // mirrors the portal home check in app/portal/page.tsx.
      // 'Activated - Need Link' and 'Link Sent - Awaiting Data' are LEGACY statuses
      // (old "email a data link, await data" flow, replaced by the wizard — no current
      // pipeline stage produces them). Kept here on purpose: both are pre-data-receipt,
      // so a row manually set to one still pauses correctly. Do not remove.
      // See docs/systems/tax-returns.md.
      const PAUSE_ELIGIBLE_TR_STATUS = new Set(['Activated - Need Link', 'Link Sent - Awaiting Data', 'Wizard Available', 'Extension Filed'])
      const pauseEligible = !trStatus || PAUSE_ELIGIBLE_TR_STATUS.has(trStatus)
      if (pauseEligible) {
        const resolved = resolveExtensionDeadline(deadlineIso, taxYear, returnType)
        const deadlineDisplay = resolved ? formatDeadlineForDisplay(resolved, locale) : null
        taxPauseBanner = (
          <TaxExtensionFiledBanner
            firstName={firstName}
            confirmationId={confirmationId}
            deadlineDisplay={deadlineDisplay}
          />
        )
      }
    }
  }

  if (taxPauseBanner) {
    return (
      <div className="px-4 py-6 lg:px-8">
        {taxPauseBanner}
      </div>
    )
  }

  // Stage-based processing check: if company_info wizard was submitted but SD is still
  // at "Company Data Pending", the tax_return_intake handler is processing (or failed).
  // Show a processing message instead of the company_info form.
  let companyInfoProcessing = false
  if (wizardType === 'company_info') {
    const ciProgressQuery = contactId
      ? supabaseAdmin.from('wizard_progress').select('status').eq('contact_id', contactId).eq('wizard_type', 'company_info').eq('status', 'submitted').limit(1).maybeSingle()
      : null
    if (ciProgressQuery) {
      const { data: ciProgress } = await ciProgressQuery
      if (ciProgress) companyInfoProcessing = true
    }
  }

  return (
    <div className="px-4 py-6 lg:px-8">
      {/* Show form selector when multiple wizards are pending (exclude banking — handled by provider picker) */}
      {(() => {
        const nonBankingWizards = wizardList.filter(w => w.type !== 'banking_payset' && w.type !== 'banking_relay')
        const hasBanking = wizardList.some(w => w.type === 'banking_payset' || w.type === 'banking_relay')
        // The merged tab that opens the Payset/Relay picker. Its label comes
        // from the shared map's 'banking' entry (that IS this concept — the
        // chooser), so it is localized like every other tab; it previously had
        // an English-only 'Banking' behind a no-op ternary.
        const showableTabs = hasBanking ? [...nonBankingWizards, { type: 'banking_payset' as const, label: wizardLabelFor('banking').en, labelIt: wizardLabelFor('banking').it, serviceType: 'Banking Fintech', submitted: wizardList.filter(w => w.type === 'banking_payset' || w.type === 'banking_relay').some(w => w.submitted) }] : nonBankingWizards
        return showableTabs.length > 1 && !forcedType ? (
        <div className="mb-6 border rounded-lg bg-white p-4">
          <p className="text-sm font-medium text-zinc-700 mb-3">
            {t('wizard.formsToComplete', locale, translations)}
          </p>
          <div className="flex flex-wrap gap-2">
            {showableTabs.map(w => {
              const isBankingTab = w.type === 'banking_payset' && hasBanking
              const isCurrent = isBankingTab
                ? (wizardType === 'banking_payset' || wizardType === 'banking_relay' || wizardType === 'banking')
                : w.type === wizardType
              return (
                <a
                  key={w.type}
                  href={`/portal/wizard?type=${w.type}`}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isCurrent
                      ? 'bg-blue-600 text-white'
                      : w.submitted
                        ? 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'
                        : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                  }`}
                >
                  {w.submitted && <span>&#10003;</span>}
                  {locale === 'it' ? w.labelIt : w.label}
                </a>
              )
            })}
          </div>
        </div>
        ) : null
      })()}
      {/* ═══ Banking: Full picker (no provider selected yet) ═══ */}
      {wizardType === 'banking' && (
        <BankingPicker locale={locale} translations={translations} wizardList={wizardList} />
      )}

      {/* ═══ Banking: Compact header + form (provider selected) ═══ */}
      {(wizardType === 'banking_payset' || wizardType === 'banking_relay') && (
        <>
          {/* Compact selected-provider header */}
          <div className="mb-4 flex items-center gap-4 rounded-xl border-2 border-blue-500 bg-white p-4">
            <div className="flex-1">
              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                {t('wizard.weHandleIt', locale, translations)}
              </span>
              <div className="mt-1.5 text-lg font-bold text-zinc-900">
                {wizardType === 'banking_relay' ? 'Relay' : 'Payset'}
                <span className="ml-2 font-normal text-sm text-zinc-500">
                  {wizardType === 'banking_relay'
                    ? t('wizard.usdBusinessAccountSuffix', locale, translations)
                    : t('wizard.eurIbanAccountSuffix', locale, translations)}
                </span>
              </div>
            </div>
            <a href="/portal/wizard?type=banking" className="text-sm font-medium text-blue-600 border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors">
              {t('wizard.changeBank', locale, translations)}
            </a>
          </div>
        </>
      )}
      {/* Company info processing state — handler running after company_info submitted */}
      {companyInfoProcessing && (
        <div className="flex flex-col items-center justify-center h-[40vh] text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4" />
          <h2 className="text-lg font-semibold text-zinc-900 mb-2">
            {t('wizard.settingUpAccount', locale, translations)}
          </h2>
          <p className="text-sm text-zinc-500 max-w-md">
            {t('wizard.settingUpAccountDesc', locale, translations)}
          </p>
        </div>
      )}
      {/* Tax year chip (PTBT fix): the client must SEE which tax year they are
          filing — the wrong-year submission was invisible because no year
          string existed anywhere in the pre-submission wizard. */}
      {wizardType === 'tax' && pinnedTaxYear !== null && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-4 py-1.5 text-sm font-semibold text-blue-800">
          🗓️ {interpolateString(t('wizard.taxYearChip', locale, translations), { year: pinnedTaxYear })}
        </div>
      )}
      {/* Don't render form when on banking picker page (no provider selected) or during company_info processing */}
      {wizardType !== 'banking' && !companyInfoProcessing && (
        <WizardClient
          wizardType={wizardType}
          entityType={entityType}
          entityUnresolved={entityUnresolved}
          prefillData={prefillData}
          savedData={savedData as Record<string, string>}
          savedStep={savedStep}
          progressId={progressId}
          accountId={accountId}
          contactId={contactId || ''}
          leadId={formationLeadId || ''}
          locale={locale}
          initialSubmitStatus={wizardSubmitStatus}
          isLocked={isLocked}
          itinCount={itinCount}
          bankGuides={bankGuides}
          institutions={institutions}
          configOverride={tdCommConfigOverride}
        />
      )}

      {/* Collapsible other banking options — shown below form when a provider is selected */}
      {(wizardType === 'banking_payset' || wizardType === 'banking_relay') && (
        <details className="mt-4 bg-white border border-zinc-200 rounded-xl p-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-600 select-none">
            {t('wizard.otherBankingOptions', locale, translations)}
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            {wizardType !== 'banking_relay' && (
              <a href="/portal/wizard?type=banking_relay" className="flex flex-col items-center gap-1 p-3 border border-zinc-200 rounded-lg hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-center">
                <span className="text-sm font-bold text-zinc-900">Relay</span>
                <span className="text-[11px] text-zinc-500">USD</span>
                <span className="text-[11px] font-medium text-blue-600">{t('wizard.fillApplication', locale, translations)} &rarr;</span>
              </a>
            )}
            {wizardType !== 'banking_payset' && (
              <a href="/portal/wizard?type=banking_payset" className="flex flex-col items-center gap-1 p-3 border border-zinc-200 rounded-lg hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-center">
                <span className="text-sm font-bold text-zinc-900">Payset</span>
                <span className="text-[11px] text-zinc-500">EUR</span>
                <span className="text-[11px] font-medium text-blue-600">{t('wizard.fillApplication', locale, translations)} &rarr;</span>
              </a>
            )}
            <a href="https://mercury.com/r/tonydurante" target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-1 p-3 border border-zinc-200 rounded-lg hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
              <span className="text-sm font-bold text-zinc-900">Mercury</span>
              <span className="text-[11px] text-zinc-500">USD</span>
              <span className="text-[11px] font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
            </a>
            <a href="https://partners.airwallex.com/149l8vgnmr5o" target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-1 p-3 border border-zinc-200 rounded-lg hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
              <span className="text-sm font-bold text-zinc-900">Airwallex</span>
              <span className="text-[11px] text-zinc-500">{t('wizard.multiShort', locale, translations)}</span>
              <span className="text-[11px] font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
            </a>
            <a href="https://platform043033.typeform.com/to/LCVzVO9f" target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-1 p-3 border border-zinc-200 rounded-lg hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
              <span className="text-sm font-bold text-zinc-900">Verto</span>
              <span className="text-[11px] text-zinc-500">FX</span>
              <span className="text-[11px] font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
            </a>
            <a href="/portal/apply/bank/sokin" target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-1 p-3 border border-zinc-200 rounded-lg hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
              <span className="text-sm font-bold text-zinc-900">Sokin</span>
              <span className="text-[11px] text-zinc-500">IBAN</span>
              <span className="text-[11px] font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
            </a>
          </div>
          <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-700 leading-relaxed">
            <strong>{t('wizard.ourRecommendationColon', locale, translations)}</strong>{' '}
            {t('wizard.applyBanksWarningShort', locale, translations)}
            <a href="/portal/chat" className="font-semibold text-emerald-800 underline">
              {t('wizard.portalChat', locale, translations)}
            </a>.
          </div>
        </details>
      )}
    </div>
  )
}

/* ═══ Banking Provider Picker (full page — no provider selected yet) ═══ */
function BankingPicker({ locale, translations, wizardList }: { locale: 'en' | 'it'; translations: Record<string, string>; wizardList: Array<{ type: string; submitted: boolean }> }) {
  const relaySubmitted = wizardList.find(w => w.type === 'banking_relay')?.submitted
  const paysetSubmitted = wizardList.find(w => w.type === 'banking_payset')?.submitted

  return (
    <div className="space-y-4 mb-6">
      <div>
        <h2 className="text-lg font-bold text-zinc-900">
          {t('wizard.bankingSetupTitle', locale, translations)}
        </h2>
        <p className="text-sm text-zinc-500">
          {t('wizard.chooseBankMethod', locale, translations)}
        </p>
      </div>

      {/* Relay + Payset cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <a href="/portal/wizard?type=banking_relay" className={`relative block rounded-xl border-2 p-5 transition-all ${relaySubmitted ? 'border-emerald-300 bg-emerald-50/50' : 'border-zinc-200 bg-white hover:border-blue-400 hover:bg-blue-50/30'}`}>
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
              {t('wizard.weHandleIt', locale, translations)}
            </span>
            {relaySubmitted && <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">&#10003; {t('wizard.submittedBadge', locale, translations)}</span>}
          </div>
          <h3 className="text-lg font-bold text-zinc-900">Relay</h3>
          <p className="text-sm text-zinc-500 mb-2">USD {t('wizard.businessAccountWord', locale, translations)}</p>
          <p className="text-xs text-zinc-600 leading-relaxed">
            {t('wizard.relayDesc', locale, translations)}
          </p>
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-300 text-lg">&rarr;</span>
        </a>
        <a href="/portal/wizard?type=banking_payset" className={`relative block rounded-xl border-2 p-5 transition-all ${paysetSubmitted ? 'border-emerald-300 bg-emerald-50/50' : 'border-zinc-200 bg-white hover:border-blue-400 hover:bg-blue-50/30'}`}>
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
              {t('wizard.weHandleIt', locale, translations)}
            </span>
            {paysetSubmitted && <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">&#10003; {t('wizard.submittedBadge', locale, translations)}</span>}
          </div>
          <h3 className="text-lg font-bold text-zinc-900">Payset</h3>
          <p className="text-sm text-zinc-500 mb-2">EUR IBAN {t('wizard.accountWord', locale, translations)}</p>
          <p className="text-xs text-zinc-600 leading-relaxed">
            {t('wizard.paysetDesc', locale, translations)}
          </p>
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-300 text-lg">&rarr;</span>
        </a>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-zinc-200" />
        <span className="text-xs text-zinc-400 font-medium uppercase tracking-wide">
          {t('wizard.orApplyDirectly', locale, translations)}
        </span>
        <div className="flex-1 h-px bg-zinc-200" />
      </div>

      {/* Self-service links */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <a href="https://mercury.com/r/tonydurante" target="_blank" rel="noopener noreferrer"
          className="flex flex-col items-center gap-1.5 rounded-lg border border-zinc-200 p-4 hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
          <span className="text-base font-bold text-zinc-900">Mercury</span>
          <span className="text-xs text-zinc-500">USD {t('wizard.accountWord', locale, translations)}</span>
          <span className="text-xs font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
        </a>
        <a href="https://partners.airwallex.com/149l8vgnmr5o" target="_blank" rel="noopener noreferrer"
          className="flex flex-col items-center gap-1.5 rounded-lg border border-zinc-200 p-4 hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
          <span className="text-base font-bold text-zinc-900">Airwallex</span>
          <span className="text-xs text-zinc-500">{t('wizard.multiCurrency', locale, translations)}</span>
          <span className="text-xs font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
        </a>
        <a href="https://platform043033.typeform.com/to/LCVzVO9f" target="_blank" rel="noopener noreferrer"
          className="flex flex-col items-center gap-1.5 rounded-lg border border-zinc-200 p-4 hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
          <span className="text-base font-bold text-zinc-900">Verto</span>
          <span className="text-xs text-zinc-500">{t('wizard.multiCurrencyFx', locale, translations)}</span>
          <span className="text-xs font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
        </a>
        <a href="/portal/apply/bank/sokin" target="_blank" rel="noopener noreferrer"
          className="flex flex-col items-center gap-1.5 rounded-lg border border-zinc-200 p-4 hover:border-violet-300 hover:bg-violet-50/30 transition-colors text-center">
          <span className="text-base font-bold text-zinc-900">Sokin</span>
          <span className="text-xs text-zinc-500">IBAN</span>
          <span className="text-xs font-medium text-violet-600">{t('wizard.applyYourself', locale, translations)} &rarr;</span>
        </a>
      </div>

      {/* Recommendation banner */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
        <span className="text-lg mt-0.5">💬</span>
        <div>
          <p className="text-sm font-semibold text-emerald-800">
            {t('wizard.ourRecommendationNoColon', locale, translations)}
          </p>
          <p className="text-sm text-emerald-700 leading-relaxed mt-1">
            {t('wizard.bankRecommendationLong', locale, translations)}
            <a href="/portal/chat" className="font-semibold text-emerald-800 underline">
              {t('wizard.portalChat', locale, translations)}
            </a>
            {t('wizard.anytimePeriod', locale, translations)}
          </p>
        </div>
      </div>
    </div>
  )
}
