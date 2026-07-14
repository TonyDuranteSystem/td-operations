/**
 * runActivation — core logic extracted from app/api/workflows/activate-service/route.ts
 *
 * Called directly (no HTTP hop) by:
 *   - app/api/workflows/activate-service/route.ts  (thin HTTP wrapper)
 *   - app/api/crm/admin-actions/confirm-payment/route.ts
 *   - app/api/webhooks/whop/route.ts
 *   - app/api/webhooks/stripe/route.ts
 *   - app/api/crm/admin-actions/retry-activation/route.ts
 */

import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import type { Json } from "@/lib/database.types"
import { createSD } from "@/lib/operations/service-delivery"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { ensureMinimalAccount, autoCreatePortalUser, sendPortalWelcomeEmail, tierForContract } from "@/lib/portal/auto-create"
import { getEntityTypeFromContract } from "@/lib/portal/entity-type-from-contract"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { createPortalNotification } from "@/lib/portal/notifications"
import { getWelcomeMessage, renderTemplate } from "@/lib/portal/welcome-message"
import { creditReferrerForLead, decideReferralAutoCredit, issueReferralCreditNote, resolveOfferCommission, shouldRecoverReferralCredit } from "@/lib/operations/referral"
import { shouldRunReferralCredit, buildPartnerDeal } from "@/lib/partners/partner-deal"
import { findTaxReturnService } from "@/lib/tax-return-context"
import { isTaxSeasonPaused } from "@/lib/settings"
import { TIER_ORDER, type PortalTier } from "@/lib/portal/tier-config"

// Auto-execute all steps immediately. Previous supervised mode with threshold
// silently blocked Valerio Sicari and Antonio Truocchio — pending_activations stayed
// at payment_confirmed with empty prepared_steps and no notification.
const AUTO_MODE_ALWAYS = true

export interface ActivationResult {
  ok: boolean
  contract_type?: string
  mode?: string
  steps?: Array<{ step: string; status: string; detail?: string }>
  service_deliveries?: unknown[]
  prepared_steps?: number
  message?: string
  error?: string
  status?: number  // HTTP status code for errors (400, 404, 500 etc)
  skipped?: string
}

interface PreparedStep {
  step: string
  action: string
  description: string
  params: Record<string, unknown>
  status: "pending" | "confirmed" | "executed" | "skipped"
}

// ─── Service Context Resolution ────────────────────────────
// Static map: service_type → context. Tax Return is ambiguous — requires explicit service_context on offer.
const BUSINESS_SERVICE_TYPES = new Set([
  'Company Formation', 'EIN', 'Banking Fintech', 'Company Closure',
  'CMRA Mailing Address', 'Annual Renewal', 'DBA',
])
const INDIVIDUAL_SERVICE_TYPES = new Set([
  'ITIN', 'ITIN Renewal',
])

/**
 * Resolve service_context for each pipeline in the offer.
 * Returns true if ANY pipeline is business-context.
 * Returns 'ambiguous' if Tax Return has no explicit service_context (caller must handle).
 * Tax Return: reads service_context from offer.services[] JSONB. Refuses to guess for safety.
 */
function hasBusinessContextPipeline(
  pipelines: string[],
  offerServices: Array<Record<string, unknown>> | null,
  offerToken: string,
): boolean | 'ambiguous' | 'multiple_matches' {
  for (const pipeline of pipelines) {
    if (BUSINESS_SERVICE_TYPES.has(pipeline)) return true
    if (INDIVIDUAL_SERVICE_TYPES.has(pipeline)) continue

    // Ambiguous type (Tax Return) — use shared helper to find service entry
    if (pipeline === 'Tax Return') {
      const trResult = findTaxReturnService(offerServices)
      if (trResult.status === 'multiple_matches') {
        console.warn(`[activate-service] Tax Return has ${trResult.count} matching entries on offer ${offerToken} — blocking activation`)
        return 'multiple_matches'
      }
      if (trResult.status === 'not_found') {
        console.warn(`[activate-service] No Tax Return service entry found on offer ${offerToken} — blocking activation`)
        return 'ambiguous'
      }
      const ctx = trResult.service_context
      if (ctx === 'individual') continue
      if (ctx === 'business') return true
      console.warn(`[activate-service] Tax Return missing service_context on offer ${offerToken} — blocking activation`)
      return 'ambiguous'
    }

    // Unknown service type — treat as business (safer: creates account)
    console.warn(`[activate-service] Unknown service_type "${pipeline}" — defaulting to business context`)
    return true
  }
  return false
}

// Map contract_type → form table + form action
const FORM_CONFIG: Record<string, {
  table: string
  leadIdField: string
  action: string
  formName: string
}> = {
  formation: {
    table: "formation_submissions",
    leadIdField: "lead_id",
    action: "formation_form_create + gmail_send",
    formName: "formation data collection form",
  },
  onboarding: {
    table: "onboarding_submissions",
    leadIdField: "lead_id",
    action: "onboarding_form_create + gmail_send",
    formName: "onboarding data collection form",
  },
  tax_return: {
    table: "tax_return_submissions",
    leadIdField: "lead_id",
    action: "tax_form_create + gmail_send",
    formName: "tax data collection form",
  },
  itin: {
    table: "itin_submissions",
    leadIdField: "lead_id",
    action: "itin_form_create + gmail_send",
    formName: "ITIN data collection form",
  },
}

export async function runActivation(pending_activation_id: string): Promise<ActivationResult> {
  // Get pending activation
  const { data: activation, error: actErr } = await supabase
    .from("pending_activations")
    .select("*")
    .eq("id", pending_activation_id)
    .single()

  if (actErr || !activation) {
    return { ok: false, error: "Activation not found", status: 404 }
  }

  if (activation.status === "activated") {
    return { ok: true, message: "Already activated" }
  }

  // Get the offer to determine contract_type and bundled_pipelines
  const { data: offer } = await supabase
    .from("offers")
    .select("contract_type, bundled_pipelines, account_id, selected_services, services, client_name, cost_summary, referrer_name, referrer_type, referrer_email, referrer_commission_type, referrer_commission_pct, referrer_agreed_price, referrer_account_id, referrer_contact_id, partner_id, partner_payout_model, partner_payout_rate, partner_invoice_target, partner_renewal_payout")
    .eq("token", activation.offer_token)
    .single()

  const contractType = offer?.contract_type || "formation"

  // Defense-in-depth: refuse renewals.
  //
  // Renewal MSAs live entirely in the annual_agreements + agreement-signed
  // pipeline. activate-service is for NEW contracts only (formation,
  // onboarding, tax_return, itin). If a renewal pending_activation reaches
  // here, the legacy code path produces phantom Paid invoices labeled
  // "Service Package - <Contact>" with no idempotency key. Mark the
  // activation activated so callers don't retry, log a warning, and exit.
  if (contractType === "renewal") {
    console.warn(
      `[activate-service] Refusing renewal contract — pending_activation ${pending_activation_id} ` +
      `(offer ${activation.offer_token}). Renewals are handled by /api/webhooks/agreement-signed; ` +
      `activate-service does not invoice them.`
    )
    await dbWriteSafe(
      supabase
        .from("pending_activations")
        .update({
          status: "activated",
          confirmation_mode: "auto",
          activated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending_activation_id),
      "pending_activations.update"
    )
    return {
      ok: true,
      contract_type: "renewal",
      skipped: "renewal — handled by agreement-signed pipeline",
    }
  }

  // Always auto-execute — supervised mode removed (caused silent failures)
  const isAutoMode = AUTO_MODE_ALWAYS

  const steps: Array<{ step: string; status: string; detail?: string }> = []
  const preparedSteps: PreparedStep[] = []

  // ─── STEP 1: Lead → Contact (AUTOMATIC) ─────────────────
  let contactId: string | null = null
  let leadId = activation.lead_id

  if (leadId) {
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .single()

    if (lead) {
      // Priority 1: Use converted_to_contact_id if set (handles multi-email clients)
      if (lead.converted_to_contact_id) {
        const { data: linkedContact } = await supabase
          .from("contacts")
          .select("id")
          .eq("id", lead.converted_to_contact_id)
          .single()
        if (linkedContact) {
          contactId = linkedContact.id
          steps.push({ step: "lead_to_contact", status: "existing", detail: `Contact from lead linkage: ${contactId}` })
        }
      }

      // Priority 2: Fall through to email search only if not yet resolved
      if (!contactId) {
        const { data: existingContact } = await supabase
          .from("contacts")
          .select("id")
          .ilike("email", lead.email || "")
          .limit(1)

        if (existingContact && existingContact.length > 0) {
          contactId = existingContact[0].id
          steps.push({ step: "lead_to_contact", status: "existing", detail: `Contact exists: ${contactId}` })
        } else {
          const { data: newContact, error: cErr } = await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; extract to lib/operations/ per dev_task fda76fd3
            supabase
              .from("contacts")
              .insert({
                full_name: lead.full_name,
                email: lead.email,
                phone: lead.phone,
                language: lead.language === "Italian" ? "it" : "en",
              })
              .select()
              .single(),
            "contacts.insert"
          )

          if (newContact) {
            contactId = newContact.id
            steps.push({ step: "lead_to_contact", status: "created", detail: `Contact created: ${contactId}` })
          } else {
            steps.push({ step: "lead_to_contact", status: "error", detail: cErr || undefined })
          }
        }
      }
    }
  } else if (activation.client_email) {
    // Try to find lead by email
    const { data: leads } = await supabase
      .from("leads")
      .select("*")
      .ilike("email", activation.client_email)
      .limit(1)

    if (leads && leads.length > 0) {
      leadId = leads[0].id

      // Priority 1: Use converted_to_contact_id if set
      if (leads[0].converted_to_contact_id) {
        const { data: linkedContact } = await supabase
          .from("contacts")
          .select("id")
          .eq("id", leads[0].converted_to_contact_id)
          .single()
        if (linkedContact) {
          contactId = linkedContact.id
        }
      }

      // Priority 2: Email search only if not yet resolved
      if (!contactId) {
        const { data: existingContact } = await supabase
          .from("contacts")
          .select("id")
          .ilike("email", leads[0].email || "")
          .limit(1)

        if (existingContact && existingContact.length > 0) {
          contactId = existingContact[0].id
        } else {
          const { data: newContact } = await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; extract to lib/operations/ per dev_task fda76fd3
            supabase
              .from("contacts")
              .insert({
                full_name: leads[0].full_name,
                email: leads[0].email,
                phone: leads[0].phone,
                language: leads[0].language === "Italian" ? "it" : "en",
              })
              .select()
              .single(),
            "contacts.insert"
          )
          if (newContact) contactId = newContact.id
        }
      }
      steps.push({ step: "lead_to_contact", status: "ok", detail: `Lead found by email, contact: ${contactId}` })
    } else {
      // No lead found — try contacts directly by email (existing clients on renewals)
      const { data: directContact } = await supabase
        .from("contacts")
        .select("id")
        .ilike("email", activation.client_email)
        .limit(1)
      if (directContact && directContact.length > 0) {
        contactId = directContact[0].id
        steps.push({ step: "lead_to_contact", status: "existing", detail: `Contact found by email (no lead): ${contactId}` })
      } else {
        steps.push({ step: "lead_to_contact", status: "skipped", detail: "No lead or contact found" })
      }
    }
  }

  // ─── STEP 1.5: Ensure Minimal Account (AUTO) ──
  let autoAccountId: string | null = offer?.account_id || null
  let isStandaloneBusinessTR = false

  // Formation excluded (Antonio's architectural model, 2026-05-03/04): when an
  // individual pays for a formation, no LLC exists yet. The account is created
  // when Articles of Organization are uploaded after state filing — either via
  // the Upload Articles button on the LLC Name Selection card or by the Drive
  // detection cron. Invoice + service deliveries + (later) members all attach
  // to the contact until then.
  //
  // See sysdoc 'ops-2026-05-03-formation-architecture-decision-and-plan'.
  //
  // Onboarding excluded per SOP v7.2 Phase 0: "NO CRM Account exists yet.
  // Only Lead (Converted) + Contact. The wizard creates the CRM Account
  // automatically when the Contact submits." Account is created by
  // lib/jobs/handlers/onboarding-setup.ts (createAccountFromWizard) instead.
  if (!autoAccountId && contactId && contractType === "formation") {
    steps.push({
      step: "ensure_account",
      status: "skipped",
      detail: "formation — account deferred until Articles of Organization arrive in Drive",
    })
  } else if (!autoAccountId && contactId && contractType !== "onboarding") {
    // For other contract types (tax_return / itin / etc.): check if any
    // pipeline is business-context. Onboarding is excluded here too per
    // SOP v7.2 — its Client Onboarding pipeline is unknown to
    // BUSINESS_SERVICE_TYPES/INDIVIDUAL_SERVICE_TYPES and would otherwise
    // default-to-business via hasBusinessContextPipeline, creating a
    // One-Time account at payment. Per SOP, the onboarding wizard submit
    // creates the account (lib/jobs/handlers/onboarding-setup.ts:180).
    const offerPipelines: string[] = Array.isArray(offer?.bundled_pipelines) ? offer.bundled_pipelines : []
    const offerServices = Array.isArray(offer?.services) ? offer.services as unknown as Record<string, unknown>[] : null
    const businessContextResult = hasBusinessContextPipeline(offerPipelines, offerServices, activation.offer_token)

    if (businessContextResult === 'ambiguous') {
      return {
        ok: false,
        error: "Tax Return activation requires explicit service_context (business or individual) on the offer. Update the offer's services[] before retrying activation.",
        steps,
        status: 400,
      }
    }

    if (businessContextResult === 'multiple_matches') {
      return {
        ok: false,
        error: "Tax Return activation blocked — offer has multiple Tax Return service entries. Update the offer to have exactly one.",
        steps,
        status: 400,
      }
    }

    if (businessContextResult === true) {
      if (contractType === "tax_return") {
        // Standalone BUSINESS Tax Return: defer account creation to company_info intake.
        // No placeholder account — SD created with contact_id only, account_id=null.
        isStandaloneBusinessTR = true
        steps.push({
          step: "ensure_account",
          status: "skipped",
          detail: "Business Tax Return — account deferred to company_info intake",
        })
      } else {
        // Other standalone business services (EIN, banking, closure, etc.)
        // The LLC exists in the real world but not in our system — create a One-Time account
        const accountResult = await ensureMinimalAccount({
          contactId,
          clientName: activation.client_name,
          contractType,
          offerToken: activation.offer_token,
          leadId: leadId || undefined,
          isStandaloneBusiness: true,
        })
        if (accountResult.accountId) {
          autoAccountId = accountResult.accountId
          steps.push({
            step: "ensure_account",
            status: accountResult.created ? "created" : "existing",
            detail: `Account ${accountResult.accountId.slice(0, 8)} (${accountResult.created ? "auto-created One-Time" : "already linked"})`,
          })
        } else {
          steps.push({ step: "ensure_account", status: "error", detail: accountResult.error })
        }
      }
    } else if (leadId) {
      // Individual-context service — try to resolve from lead (legacy fallback)
      const { data: lead } = await supabase.from("leads").select("converted_to_account_id").eq("id", leadId).maybeSingle()
      autoAccountId = lead?.converted_to_account_id || null
    }
  }

  // ─── STEP 1.6: Auto-upgrade account_type + propagate financial fields ──
  // Formation: skipped — formation does not own an account at payment time.
  //   The account is created later when Articles arrive; account_type is set
  //   there from the contract data.
  //
  // Onboarding (existing-account re-entry — Mojo Labs LLC pattern, 2026-05-06):
  //   When an existing One-Time customer signs an annual onboarding offer,
  //   the wizard handler's UPDATE branch does NOT touch account_type, so
  //   without this helper the account stays "One-Time" and `tier-config.ts:
  //   ONE_TIME_EXCLUDED` keeps banking/billing/invoices/deadlines hidden in
  //   the portal. The helper also propagates Setup Fee + 1st + 2nd installment
  //   amounts from the offer to the account so next year's renewal cron
  //   (annual-installments) has the right numbers.
  //
  //   Guards: only flips One-Time/null → Client (never downgrades from
  //   Client/Closed/etc). Only writes columns when their current value is
  //   null. Only flips account_type when at least one installment parses
  //   from recurring_costs (pure setup-fee one-shots stay One-Time).
  //
  //   Onboarding without an existing account_id (the new-lead onboarding
  //   path per SOP v7.2 Phase 0) is unaffected — `applyOnboardingAccountUpgrades`
  //   short-circuits when accountId is missing or contract_type isn't 'onboarding'.
  if (contractType === "onboarding" && autoAccountId && offer) {
    try {
      const { applyOnboardingAccountUpgrades } = await import("@/lib/operations/onboarding-account-upgrade")
      const upgrade = await applyOnboardingAccountUpgrades({
        accountId: autoAccountId,
        offer: {
          contract_type: offer.contract_type,
          cost_summary: offer.cost_summary,
          // offer.recurring_costs isn't included in the SELECT above — refetch
          // just that column to keep the existing query unchanged. Cheap
          // single-column read.
          recurring_costs: await (async () => {
            const { data } = await supabase
              .from("offers")
              .select("recurring_costs")
              .eq("token", activation.offer_token)
              .single()
            return data?.recurring_costs ?? null
          })(),
        },
        actor: "activate-service",
      })
      steps.push({
        step: "account_upgrade",
        status: upgrade.applied ? "done" : "skipped",
        detail: [
          upgrade.account_type_flipped ? `account_type ${upgrade.account_type_before ?? "null"} → Client` : null,
          upgrade.setup_fee_written ? `setup_fee=${upgrade.setup_fee_written.amount} ${upgrade.setup_fee_written.currency}` : null,
          upgrade.installment_1_written ? `installment_1=${upgrade.installment_1_written.amount} ${upgrade.installment_1_written.currency}` : null,
          upgrade.installment_2_written ? `installment_2=${upgrade.installment_2_written.amount} ${upgrade.installment_2_written.currency}` : null,
        ].filter(Boolean).join(" | ") || (upgrade.notes[0] ?? "no changes"),
      })
    } catch (e) {
      steps.push({
        step: "account_upgrade",
        status: "error",
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // ─── STEP 2: Service Deliveries from bundled_pipelines (AUTO) ─────
  const sdResults: Array<{ pipeline: string; status: string; id?: string }> = []
  const pipelines: string[] = Array.isArray(offer?.bundled_pipelines) ? offer.bundled_pipelines : []

  // Build quantity map: how many SDs to create per pipeline.
  // Quantity > 1 is set by the Create Offer dialog for multi-unit services (e.g. ITIN ×2).
  // The quantity is stored in offer.services[i].quantity alongside pipeline_type.
  // For services without an explicit quantity, default is 1.
  const pipelineQuantity = new Map<string, number>()
  if (Array.isArray(offer?.services)) {
    for (const svc of offer.services as Array<Record<string, unknown>>) {
      const pType = svc.pipeline_type as string | undefined
      const qty = typeof svc.quantity === 'number' && svc.quantity > 1 ? svc.quantity : 1
      if (pType && qty > 1) {
        // Take the max if multiple service rows map to the same pipeline
        pipelineQuantity.set(pType, Math.max(pipelineQuantity.get(pType) ?? 1, qty))
      }
    }
  }

  // Formation vs Onboarding SD-creation policy (SOP v7.2):
  //
  // Formation: SD created AT PAYMENT — but contact-scoped (account_id=null)
  // because the LLC does not exist yet (waiting for Secretary of State Articles
  // of Organization). The portal switcher (getInProgressFormations in
  // lib/portal/queries.ts) keys off this contact-scoped SD to surface "New
  // company (in formation)" so returning active clients (whose contact tier
  // stays at 'active'; the tier-based wizard-visibility fallback cannot fire
  // for them) can reach the wizard. formation-setup.ts dedupes at wizard submit
  // (contact_id + service_type + status='active') so no double-create.
  // Banking Fintech SD is still created at EIN received (record-ein-received).
  //
  // Onboarding: SDs created by wizard submit / closing per SOP v7.2.
  //   - Phase 1 Auto-Chain step 6: wizard creates Client Onboarding SD
  //   - Phase 1 Auto-Chain step 11: wizard creates Tax Return SD when answer is "No"
  //   - Phase 3 steps 30-31: closing creates RA Renewal + Annual Report SDs
  if (contractType === "formation") {
    // Contact-scoped Company Formation SD at activation. The portal switcher
    // (getInProgressFormations) keys off this row to surface "New company (in
    // formation)" — required for returning active clients whose contact tier
    // stays at 'active' (the tier-based wizard fallback in wizard-visibility.ts
    // cannot fire for them). formation-setup.ts dedupes at wizard submit.
    if (contactId) {
      // Dedup key = the originating offer token, now a first-class column.
      // The partial unique index uq_formation_sd_active_per_offer is the REAL
      // guard against the concurrent/retried-activation race (Michele Cotti got
      // two formation SDs 2s apart, 2026-06-10). The pre-check below is just the
      // fast path; the catch handles the race when two inserts collide.
      const { data: existingByOffer } = await supabase
        .from("service_deliveries")
        .select("id")
        .eq("service_type", "Company Formation")
        .eq("source_offer_token", activation.offer_token)
        .is("account_id", null)
        .eq("status", "active")
        .limit(1)

      if ((existingByOffer?.length ?? 0) > 0) {
        sdResults.push({ pipeline: "Company Formation", status: "existing", id: existingByOffer![0]?.id })
        steps.push({
          step: "service_deliveries",
          status: "skipped",
          detail: `formation — Company Formation SD already exists for offer ${activation.offer_token}: ${existingByOffer![0]?.id}`,
        })
      } else {
        try {
          const sd = await createSD({
            service_type: "Company Formation",
            contact_id: contactId,
            account_id: null,
            // v2 Company Formation pipeline stage_order=1 (migration 20260617).
            // The old "Data Collection" name no longer exists for this service
            // type, so a new SD created with it had an invalid stage.
            target_stage: "Payment Confirmed",
            target_stage_order: 1,
            notes: `Auto-created from offer ${activation.offer_token}`,
            source_offer_token: activation.offer_token,
          })
          sdResults.push({ pipeline: "Company Formation", status: "created", id: sd.id })
          steps.push({
            step: "service_deliveries",
            status: "created",
            detail: `formation — Company Formation SD created (contact-scoped, account_id=null): ${sd.id}`,
          })
        } catch (e) {
          // The DB unique index is the real guard: under a concurrent/retried
          // activation the losing INSERT throws here. Re-select the winner and
          // report "existing" instead of a spurious error so the race is silent.
          const { data: raceWinner } = await supabase
            .from("service_deliveries")
            .select("id")
            .eq("service_type", "Company Formation")
            .eq("source_offer_token", activation.offer_token)
            .is("account_id", null)
            .eq("status", "active")
            .limit(1)
            .maybeSingle()
          if (raceWinner?.id) {
            sdResults.push({ pipeline: "Company Formation", status: "existing", id: raceWinner.id })
            steps.push({
              step: "service_deliveries",
              status: "skipped",
              detail: `formation — Company Formation SD already exists (race-deduped) for offer ${activation.offer_token}: ${raceWinner.id}`,
            })
          } else {
            steps.push({
              step: "service_deliveries",
              status: "error",
              detail: `formation — createSD failed: ${e instanceof Error ? e.message : String(e)}`,
            })
          }
        }
      }
    } else {
      steps.push({
        step: "service_deliveries",
        status: "skipped",
        detail: "formation — no contactId available; cannot create contact-scoped Company Formation SD",
      })
    }
  } else if (contractType === "onboarding") {
    steps.push({
      step: "service_deliveries",
      status: "skipped",
      detail: "onboarding — SDs created by wizard submit / closing per SOP v7.2",
    })
  } else if (pipelines.length > 0) {
    // Get first pipeline stage for each type (including auto_tasks for task creation)
    const { data: allStages } = await supabase
      .from("pipeline_stages")
      .select("service_type, stage_name, stage_order, auto_tasks")
      .in("service_type", pipelines)
      .order("stage_order", { ascending: true })

    const firstStage = new Map<string, string>()
    const firstStageData = new Map<string, { stage_name: string; stage_order: number; auto_tasks: Array<{ title: string; assigned_to: string; category: string; priority?: string }> }>()
    if (allStages) {
      for (const s of allStages) {
        if (!firstStage.has(s.service_type)) {
          firstStage.set(s.service_type, s.stage_name)
          firstStageData.set(s.service_type, {
            stage_name: s.stage_name,
            stage_order: s.stage_order,
            auto_tasks: Array.isArray(s.auto_tasks) ? s.auto_tasks as unknown as Array<{ title: string; assigned_to: string; category: string; priority?: string }> : [],
          })
        }
      }
    }

    // Use autoAccountId (may have been created in Step 1.5)
    const accountId = autoAccountId

    for (const pipeline of pipelines) {
      try {
        const quantity = pipelineQuantity.get(pipeline) ?? 1

        // Guard 1: count SDs already created for this exact offer + pipeline
        // (tied by offer_token in notes — the canonical link).
        // For quantity > 1, we need exactly `quantity` SDs; skip if we already have them all.
        const { data: existingByOffer } = await supabase
          .from("service_deliveries")
          .select("id")
          .eq("service_type", pipeline)
          .ilike("notes", `%${activation.offer_token}%`)

        const existingOfferCount = existingByOffer?.length ?? 0
        if (existingOfferCount >= quantity) {
          sdResults.push({ pipeline, status: "existing", id: existingByOffer![0]?.id })
          continue
        }

        // Guard 2: same service_type already active on this account via another path.
        // For quantity > 1, allow up to `quantity` active SDs of this type.
        if (accountId) {
          const { data: activeSds } = await supabase
            .from("service_deliveries")
            .select("id")
            .eq("service_type", pipeline)
            .eq("account_id", accountId)
            .eq("status", "active")
          if ((activeSds?.length ?? 0) >= quantity) {
            sdResults.push({ pipeline, status: "existing", id: activeSds![0]?.id })
            continue
          }
        }

        // How many more SDs to create (quantity minus what already exists for this offer)
        const toCreate = quantity - existingOfferCount

        // Tax season pause computed once before the quantity loop (same result for all N SDs)
        const taxPausedBundled = pipeline === "Tax Return" && !isStandaloneBusinessTR
          ? await isTaxSeasonPaused()
          : false
        const taxPauseNote = taxPausedBundled ? " [on_hold — tax_season_paused flag set]" : ""

        // Create `toCreate` SDs for this pipeline.
        // For quantity > 1, each SD is suffixed with "#N" so they are distinguishable
        // in the CRM. Per-member identification happens later in the portal flow.
        for (let unitIndex = 0; unitIndex < toCreate; unitIndex++) {
          const unitSuffix = quantity > 1 ? ` #${existingOfferCount + unitIndex + 1}` : ""
          const sdName = `${pipeline} - ${activation.client_name}${unitSuffix}`

          // Route through P1.6 operation layer (createSD).
          // Tax Return has context-dependent entry points — pass target_stage
          // + target_stage_order explicitly so createSD uses the contextual
          // value instead of defaulting to stage_order=-1 "Company Data
          // Pending".
          let createParams: Parameters<typeof createSD>[0]
          if (pipeline === "Tax Return") {
            if (isStandaloneBusinessTR) {
              createParams = {
                service_type: pipeline,
                service_name: sdName,
                account_id: null,
                contact_id: contactId,
                target_stage: "Company Data Pending",
                target_stage_order: -1,
                status: "active",
                notes: `Auto-created from offer ${activation.offer_token}`,
              }
            } else {
              createParams = {
                service_type: pipeline,
                service_name: sdName,
                account_id: accountId,
                contact_id: contactId,
                target_stage: "1st Installment Paid",
                status: taxPausedBundled ? "on_hold" : "active",
                notes: `Auto-created from offer ${activation.offer_token}${taxPauseNote}`,
              }
            }
          } else if (pipeline === "ITIN") {
            // Phase 1 ITIN rule (2026-05-11): ITIN SDs live on contact_id
            // with account_id=null, even when the contact owns an LLC.
            // createSD enforces this defensively too.
            createParams = {
              service_type: pipeline,
              service_name: sdName,
              account_id: null,
              contact_id: contactId,
              notes: `Auto-created from offer ${activation.offer_token}`,
            }
          } else {
            // All other pipelines — createSD resolves the first stage
            // from pipeline_stages automatically.
            createParams = {
              service_type: pipeline,
              service_name: sdName,
              account_id: accountId,
              contact_id: contactId,
              notes: `Auto-created from offer ${activation.offer_token}`,
            }
          }

          const sd = await createSD(createParams)
          sdResults.push({ pipeline, status: "created", id: sd.id })

          // Auto-create tasks from pipeline_stages.auto_tasks (mirrors
          // sd_create logic — kept here because createSD intentionally
          // does not create tasks on insert).
          const stageData = firstStageData.get(pipeline)
          if (sd.id && stageData?.auto_tasks?.length) {
            for (const taskDef of stageData.auto_tasks) {
              await dbWriteSafe(
                // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw tasks.insert; extract to lib/operations/ per dev_task fda76fd3
                supabase.from("tasks").insert({
                  task_title: `[${sdName}] ${taskDef.title}`,
                  assigned_to: taskDef.assigned_to || "Luca",
                  category: (taskDef.category || "Internal") as never,
                  priority: (taskDef.priority || "Normal") as never,
                  description: "Auto-created on service delivery creation",
                  status: "To Do",
                  // Use the SD's resolved ids so contact-only SDs (ITIN per
                  // Phase 1 rule) get contact-scoped tasks with null account_id.
                  account_id: sd.account_id,
                  contact_id: sd.contact_id,
                  delivery_id: sd.id,
                  stage_order: stageData.stage_order,
                }),
                "tasks.insert"
              )
            }
          }
        }
      } catch (e) {
        sdResults.push({ pipeline, status: "error", id: e instanceof Error ? e.message : String(e) })
      }
    }

    const created = sdResults.filter(r => r.status === "created").length
    const existing = sdResults.filter(r => r.status === "existing").length
    steps.push({
      step: "service_deliveries",
      status: "done",
      detail: `${created} created, ${existing} existing, ${sdResults.length} total from bundled_pipelines`,
    })
  } else {
    steps.push({ step: "service_deliveries", status: "skipped", detail: "No bundled_pipelines on offer" })
  }

  // ─── STEP 2a: Mark included Tax Return as paid (AUTO) ─────
  // If Tax Return SD was created and the offer has Tax Return with price "Inclusa"/"Included",
  // update the tax_returns record to paid=true so Stage 1 task knows to skip invoicing.
  const taxReturnSd = sdResults.find(r => r.pipeline === "Tax Return" && r.status === "created")
  if (taxReturnSd?.id && offer?.services && autoAccountId) {
    const services = Array.isArray(offer.services) ? offer.services : []
    const includedTaxReturn = services.find((s: { pipeline_type?: string; price?: string }) =>
      s.pipeline_type === "Tax Return" &&
      s.price &&
      /inclus[ao]|included|€?\s*0/i.test(s.price)
    )
    if (includedTaxReturn) {
      const today = new Date().toISOString().split("T")[0]
      // Check if tax_returns record exists for this account + current year
      const currentYear = new Date().getFullYear()
      const { data: existingTr } = await supabase
        .from("tax_returns")
        .select("id")
        .eq("account_id", autoAccountId)
        .eq("tax_year", currentYear - 1) // Tax return is for previous year (e.g., 2025 return filed in 2026)
        .limit(1)

      if (existingTr && existingTr.length > 0) {
        await dbWriteSafe(
          supabase
            .from("tax_returns")
            .update({ paid: true, paid_date: today })
            .eq("id", existingTr[0].id),
          "tax_returns.update"
        )
        steps.push({ step: "tax_return_paid", status: "updated", detail: `tax_returns ${existingTr[0].id.slice(0, 8)} marked paid (included in deal)` })
      } else {
        steps.push({ step: "tax_return_paid", status: "skipped", detail: `No tax_returns record found for ${currentYear - 1}` })
      }
    }
  }

  // ─── STEP 2b: Portal tier upgrade (AUTO) ─────────────────
  // Upgrade portal tier from lead → tierForContract(contractType) after payment.
  // formation → formation, onboarding → onboarding, everything else → active.
  const targetTier: PortalTier = tierForContract(contractType)
  if (autoAccountId) {
    // Business-context: upgrade via account (syncs account + all linked contacts + auth users)
    const { syncTier } = await import("@/lib/operations/sync-tier")
    const tierResult = await syncTier({ accountId: autoAccountId, newTier: targetTier, reason: 'payment confirmed — portal tier activate' })
    const tierAlreadyAtOrAbove = (TIER_ORDER[(tierResult.previousTier || '') as PortalTier] ?? -1) >= TIER_ORDER[targetTier]
    steps.push({ step: "portal_tier_upgrade", status: tierResult.success ? "done" : "error", detail: tierResult.success ? (tierAlreadyAtOrAbove ? `Already ${tierResult.previousTier} (no change)` : `${tierResult.previousTier || "lead"} → ${targetTier} (via account)`) : (tierResult.error || "Unknown error") })
  } else if (contactId) {
    // Contact-only (individual service): upgrade contacts.portal_tier + auth metadata directly
    // Must keep all tier sources in sync: contacts table + auth.users.app_metadata
    try {
      const { data: currentContact } = await supabase
        .from("contacts")
        .select("portal_tier, email")
        .eq("id", contactId)
        .single()

      const currentTier = currentContact?.portal_tier || "lead"
      const currentIdx = TIER_ORDER[(currentTier as PortalTier)] ?? -1
      const newIdx = TIER_ORDER[targetTier]

      if (newIdx > currentIdx) {
        // 1. Update contacts.portal_tier
        /* eslint-disable no-restricted-syntax -- pre-P2.4 raw contacts.update + Phase D1 portal_tier; extract to lib/operations/portal.ts reconcileTier() per dev_task fda76fd3 */
        await dbWrite(
          supabase
            .from("contacts")
            .update({ portal_tier: targetTier })
            .eq("id", contactId),
          "contacts.update"
        )
        /* eslint-enable no-restricted-syntax */

        // 2. Update auth.users.app_metadata.portal_tier (paginated — P1.9)
        if (currentContact?.email) {
          const authUser = await findAuthUserByEmail(currentContact.email)
          if (authUser) {
            await supabase.auth.admin.updateUserById(authUser.id, {
              app_metadata: { ...authUser.app_metadata, portal_tier: targetTier },
            })
          }
        }

        steps.push({ step: "portal_tier_upgrade", status: "done", detail: `${currentTier} → ${targetTier} (contact-only, no account)` })
      } else {
        steps.push({ step: "portal_tier_upgrade", status: "done", detail: `Already at ${currentTier} (no downgrade)` })
      }
    } catch (e) {
      steps.push({ step: "portal_tier_upgrade", status: "error", detail: `Contact-only upgrade failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  } else {
    steps.push({ step: "portal_tier_upgrade", status: "skipped", detail: "No account or contact available" })
  }

  // ─── STEP 2c: Auto-create portal user + welcome email (AUTO) ──────
  if (contactId) {
    const portalResult = await autoCreatePortalUser({
      contactId,
      accountId: autoAccountId || undefined,
      tier: targetTier,
    })

    if (portalResult.success && !portalResult.alreadyExists && portalResult.tempPassword && portalResult.email) {
      // New user created — send welcome email
      const { data: contact } = await supabase
        .from("contacts")
        .select("language")
        .eq("id", contactId)
        .single()

      const lang = contact?.language === "Italian" || contact?.language === "it" ? "it" : "en"
      const emailResult = await sendPortalWelcomeEmail({
        email: portalResult.email,
        fullName: activation.client_name,
        tempPassword: portalResult.tempPassword,
        language: lang,
      })

      steps.push({
        step: "portal_user",
        status: "created",
        detail: `Auth user created for ${portalResult.email}. Welcome email: ${emailResult.success ? "sent" : emailResult.error}`,
      })
    } else if (portalResult.alreadyExists) {
      steps.push({ step: "portal_user", status: "existing", detail: `Portal user already exists: ${portalResult.email}` })
    } else if (!portalResult.success) {
      steps.push({ step: "portal_user", status: "error", detail: portalResult.error })
    }

    // Welcome notification + portal message at activation.
    //
    // Bug 2 fix (master 9e27e14f, sysdoc ops-2026-05-07-onetime-to-active-journey-fix-plan):
    // for onboarding and formation, send a clear "Welcome onboard, complete
    // the wizard" call-to-action so the customer knows the next step.
    // The previous generic "service is being set up" notification gave no
    // direction — clients were left guessing what to do next, especially in
    // the no-lead path where they jump straight from payment to portal
    // without a follow-up email.
    if (contactId) {
      try {
        // Fetch contact name + language and (optionally) account company_name
        // so {{firstName}}, {{lastName}}, {{companyName}} placeholders in the
        // catalog-driven welcome templates can be substituted.
        const { data: contact } = await supabase
          .from("contacts")
          .select("language, first_name, last_name, full_name")
          .eq("id", contactId)
          .single()

        let companyName: string | undefined
        if (autoAccountId) {
          const { data: acct } = await supabase
            .from("accounts")
            .select("company_name")
            .eq("id", autoAccountId)
            .single()
          companyName = acct?.company_name ?? undefined
        }
        if (!companyName) companyName = activation.client_name || undefined

        const language: "it" | "en" =
          contact?.language === "it" || contact?.language === "Italian" ? "it" : "en"

        // ONE combined welcome per offer (Antonio's locked decision): for
        // bundled offers, getWelcomeMessage picks the highest-priority template
        // across all pipelines. Falls back to contractType when pipelines is
        // empty (e.g. onboarding/formation where the SD is created later by
        // the wizard, not at payment).
        const template = await getWelcomeMessage({
          contractType,
          pipelines,
          language,
        })

        // Derive firstName from full_name when first_name is missing.
        const firstName =
          contact?.first_name ||
          (contact?.full_name ? contact.full_name.split(/\s+/)[0] : undefined)

        if (template) {
          const vars = {
            firstName,
            lastName: contact?.last_name ?? undefined,
            companyName,
            serviceName: template.title,
            wizardUrl: template.wizardPath ?? "/portal/wizard",
          }
          const title = renderTemplate(template.title, vars)
          const body = renderTemplate(template.body, vars)
          const link = template.wizardPath ?? "/portal"

          createPortalNotification({
            account_id: autoAccountId || undefined,
            contact_id: contactId,
            type: "service",
            title,
            body,
            link,
          }).catch(() => {})

          // portal_messages.account_id IS NULL-able (verified 2026-05-14) — we
          // insert whenever either account_id or contact_id is set, which fixes
          // the previous bug where ITIN-only activations (no autoAccountId)
          // silently skipped the chat message. Valerio Sicari hit this case on
          // 2026-05-13 and needed a manual follow-up.
          await supabase.from("portal_messages").insert({
            account_id: autoAccountId,
            contact_id: contactId,
            sender_type: "admin",
            sender_id: "b0da5d9c-acf6-4761-9cae-2c3b14dbc631",
            message: `${title}\n\n${body}`,
          })
        } else {
          // No catalog template matched — fall back to the legacy generic copy
          // so any service we forgot to seed still produces SOME welcome rather
          // than dead silence.
          const title =
            language === "it"
              ? "Benvenuto! Il tuo servizio sta per partire"
              : "Welcome! Your service is being set up"
          const body =
            language === "it"
              ? "Stiamo preparando il tuo servizio. Accedi al portale per i prossimi passi."
              : "We're preparing your service. Check the portal for next steps."

          createPortalNotification({
            account_id: autoAccountId || undefined,
            contact_id: contactId,
            type: "service",
            title,
            body,
            link: "/portal",
          }).catch(() => {})
        }
      } catch (e) {
        // Notification + message are best-effort. Don't fail activation.
        console.error("[activate-service] welcome notification failed:", e)
      }
    }
  } else {
    steps.push({ step: "portal_user", status: "skipped", detail: "No contact_id available" })
  }

  // ─── STEP 3: Unified Invoice + QB Sync (AUTO) ──────────
  // Creates in BOTH client_invoices (portal) and payments (CRM), linked by FK
  // DEDUP: If offer-signed already created an invoice (portal_invoice_id on activation), skip creation and just mark it Paid
  //
  // paymentIdForPayout: the payments.id of the just-created/just-paid TD invoice.
  // Step 3.6 (partner payout) needs this to attach the payout to the source
  // payment for traceability and FK integrity.
  let paymentIdForPayout: string | null = null
  if (activation.portal_invoice_id) {
    // Invoice already created at signing — mark it Paid now, THROUGH THE ONE MONEY
    // WRITER (2026-07-14).
    //
    // This used to call syncInvoiceStatus('payment', …) — the old writer, which
    // OVERWRITES amount_paid, never writes amount_due, has no terminal guard and
    // leaves no audit row. It runs immediately after the bank-feed matcher settles the
    // very same invoice (the orchestrator activates right after the match), so it
    // could overwrite what the matcher had just correctly recorded. Worst case: the
    // matcher records a PART-payment (balance still owed) and this then force-stamped
    // the invoice Paid with the balance still outstanding — manufacturing exactly the
    // half-closed invoices this work exists to eliminate.
    //
    // applyMoneyToInvoice refuses to touch an already-settled invoice, so when the
    // matcher got there first this is now a safe no-op instead of a clobber.
    try {
      const today = new Date().toISOString().split("T")[0]
      paymentIdForPayout = activation.portal_invoice_id
      const { applyMoneyToInvoice } = await import("@/lib/finance/apply-payment")
      // settle_full, never "apply": activation means the payment was CONFIRMED in
      // full. Accumulating the activation amount on top of what a bank feed may have
      // already credited would double-count it. If the invoice is already settled,
      // the writer no-ops.
      await applyMoneyToInvoice({
        paymentId: activation.portal_invoice_id,
        mode: "settle_full",
        paidDate: today,
        actor: "activate-service",
      })

      // Backfill account_id on the existing invoice if we now have one
      if (autoAccountId) {
        await dbWriteSafe(
          supabase
            .from("client_invoices")
            .update({ account_id: autoAccountId, updated_at: new Date().toISOString() })
            .eq("id", activation.portal_invoice_id)
            .is("account_id", null),
          "client_invoices.update"
        )

        // Also update the linked payment record
        const { data: linkedPay } = await supabase
          .from("payments")
          .select("id")
          .eq("portal_invoice_id", activation.portal_invoice_id)
          .limit(1)
          .maybeSingle()
        if (linkedPay) {
          await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw payments.update; extract to lib/operations/ per dev_task fda76fd3
            supabase
              .from("payments")
              .update({ account_id: autoAccountId, updated_at: new Date().toISOString() })
              .eq("id", linkedPay.id)
              .is("account_id", null),
            "payments.update"
          )
        }
      }

      // Get invoice number for logging
      const { data: existingInv } = await supabase
        .from("client_invoices")
        .select("invoice_number")
        .eq("id", activation.portal_invoice_id)
        .single()

      steps.push({
        step: "crm_invoice",
        status: "marked_paid",
        detail: `${existingInv?.invoice_number || activation.portal_invoice_id} — marked Paid (created at signing)`,
      })

      // QB sync removed — manual now (CRM "Push to QuickBooks" button).
    } catch (e) {
      steps.push({ step: "crm_invoice", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }
  } else if ((autoAccountId || contactId) && activation.amount) {
    try {
      const today = new Date().toISOString().split("T")[0]
      const amount = Number(activation.amount)
      const serviceLabel = contractType === "formation" ? "LLC Formation"
        : contractType === "onboarding" ? "LLC Onboarding"
        : contractType === "tax_return" ? "Tax Return"
        : contractType === "itin" ? "ITIN Application"
        : "Service"

      const invoiceResult = await createTDInvoice({
        account_id: autoAccountId || undefined,
        contact_id: contactId || undefined,
        line_items: [{
          description: `${serviceLabel} Package - ${activation.client_name}`,
          unit_price: amount,
          quantity: 1,
        }],
        currency: (activation.currency || "USD") as 'USD' | 'EUR',
        mark_as_paid: true,
        paid_date: today,
        payment_method: activation.payment_method || "Whop",
        whop_payment_id: activation.whop_membership_id || null,
      })

      // Store payment reference on activation for traceability
      await dbWriteSafe(
        supabase
          .from("pending_activations")
          .update({ portal_invoice_id: invoiceResult.paymentId })
          .eq("id", pending_activation_id),
        "pending_activations.update"
      )
      paymentIdForPayout = invoiceResult.paymentId

      steps.push({
        step: "crm_invoice",
        status: "created",
        detail: `${invoiceResult.invoiceNumber} — ${activation.currency} ${amount} (Paid)`,
      })

      // QB sync removed — manual now (CRM "Push to QuickBooks" button).
    } catch (e) {
      steps.push({ step: "crm_invoice", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }
  } else if (!autoAccountId && !contactId) {
    steps.push({ step: "crm_invoice", status: "skipped", detail: "No account or contact to link invoice to" })
  } else {
    steps.push({ step: "crm_invoice", status: "skipped", detail: "No amount on activation" })
  }

  // ─── STEP 3.5: Referral Record (AUTO, non-blocking) ──────
  let referralNoteLine = ""
  try {
    if (offer && shouldRunReferralCredit(offer)) {
      const offerReferrerAccountId = offer.referrer_account_id || null
      const offerReferrerContactId = (offer as { referrer_contact_id?: string | null }).referrer_contact_id || null

      // a. Resolve the referrer contact. Prefer the id the offer picker pinned
      //    (deterministic — no name guessing). If the referrer is an ACCOUNT
      //    (company/partner) with no contact, skip contact resolution entirely —
      //    the credit lands on that account. Only free-text referrers (no ids at
      //    all) fall back to the legacy name-match, then create-a-contact.
      let referrerContactId: string | null = offerReferrerContactId

      if (!referrerContactId && !offerReferrerAccountId) {
        const { data: referrerContacts } = await supabase
          .from("contacts")
          .select("id")
          .ilike("full_name", offer.referrer_name)
          .limit(1)

        if (referrerContacts && referrerContacts.length > 0) {
          referrerContactId = referrerContacts[0].id
        } else {
          // Create minimal contact for the referrer (free-text referrer only)
          const { data: newReferrer } = await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; extract to lib/operations/ per dev_task fda76fd3
            supabase
              .from("contacts")
              .insert({
                full_name: offer.referrer_name,
                email: offer.referrer_email || null,
                referrer_type: offer.referrer_type || null,
              })
              .select("id")
              .single(),
            "contacts.insert"
          )
          referrerContactId = newReferrer?.id || null
        }
      }

      if (referrerContactId || offerReferrerAccountId) {
        // b. Parse setup fee from cost_summary
        let setupFeeTotal = 0
        try {
          const costSummary = Array.isArray(offer.cost_summary) ? offer.cost_summary : []
          if (costSummary.length > 0) {
            const firstSection = costSummary[0] as { total?: string }
            if (firstSection.total) {
              setupFeeTotal = Number(String(firstSection.total).replace(/[€$,.\s]/g, (m) => m === "," ? "" : m === "." ? "." : "")) || 0
              // Handle European format: €2.500 or €2,500
              if (setupFeeTotal > 100000) setupFeeTotal = setupFeeTotal / 100
            }
          }
        } catch { /* cost_summary parse failed, setupFeeTotal stays 0 */ }

        // c. Determine commission type, amount, currency (USD reward — pure helper)
        const { commissionType, commissionPct, commissionAmount, commissionCurrency } = resolveOfferCommission(offer, setupFeeTotal)

        // d. Idempotency / cross-path dedup: skip if a referral already exists
        //    for this offer (re-activation) or this lead (a Calendly pending
        //    referral that Step 3.5b will credit) — prevents duplicate rows AND
        //    double credits now that this path auto-issues the credit.
        const dedupFilters = [`offer_token.eq.${activation.offer_token}`]
        if (leadId) dedupFilters.push(`referred_lead_id.eq.${leadId}`)
        const { data: existingReferral } = await supabase
          .from("referrals")
          .select("id, status, credited_amount, referrer_account_id, referrer_contact_id, commission_amount")
          .or(dedupFilters.join(","))
          .neq("status", "cancelled")
          .limit(1)
          .maybeSingle()

        if (existingReferral) {
          const ex = existingReferral as { id: string; status: string; credited_amount: number | null; referrer_account_id: string | null; referrer_contact_id: string | null; commission_amount: number | null }
          // Self-heal: if a prior activation inserted the referral but was killed
          // BEFORE issuing the credit (converted + uncredited), credit it now.
          // Idempotent via issueReferralCreditNote's idempotency_key, so this can
          // never double-pay.
          if (shouldRecoverReferralCredit({ status: ex.status, creditedAmount: ex.credited_amount, commissionAmount: ex.commission_amount })) {
            let recoverAccount = ex.referrer_account_id
            if (!recoverAccount && ex.referrer_contact_id) {
              const { data: link } = await supabase
                .from("account_contacts").select("account_id").eq("contact_id", ex.referrer_contact_id).limit(1).maybeSingle()
              recoverAccount = (link as { account_id: string } | null)?.account_id ?? null
            }
            if (recoverAccount) {
              try {
                await issueReferralCreditNote(
                  { referralId: ex.id, referrerAccountId: recoverAccount, amount: Number(ex.commission_amount), currency: "USD", description: "Referral reward — credit (recovered)" },
                  supabase,
                )
                steps.push({ step: "referral", status: "credited", detail: `Recovered uncredited referral ${ex.id.slice(0, 8)} → ${ex.commission_amount} USD` })
              } catch (recoverErr) {
                steps.push({ step: "referral", status: "skipped", detail: `Referral ${ex.id.slice(0, 8)} (${ex.status}); credit recovery failed: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}` })
              }
            } else {
              steps.push({ step: "referral", status: "skipped", detail: `Referral already exists (${ex.id.slice(0, 8)}, ${ex.status}) — uncredited, no account to recover` })
            }
          } else {
            steps.push({ step: "referral", status: "skipped", detail: `Referral already exists (${ex.id.slice(0, 8)}, ${ex.status}) — no duplicate created` })
          }
        } else {
          // e. Insert referral record
          const { data: referral, error: refErr } = await dbWriteSafe(
            supabase
              .from("referrals")
              .insert({
                referrer_contact_id: referrerContactId,
                referrer_account_id: offer.referrer_account_id || null,
                referred_contact_id: contactId || null,
                referred_account_id: autoAccountId || null,
                referred_lead_id: leadId || null,
                referred_name: offer.client_name || activation.client_name,
                offer_token: activation.offer_token,
                referrer_type: offer.referrer_type || "client",
                status: "converted",
                commission_type: commissionType,
                commission_pct: commissionPct,
                commission_amount: commissionAmount || null,
                commission_currency: commissionCurrency,
              })
              .select("id")
              .single(),
            "referrals.insert"
          )

          if (refErr || !referral) {
            steps.push({ step: "referral", status: "error", detail: `Insert failed: ${refErr}` })
          } else {
            // Resolve the referrer's account to credit (offer's account, else the
            // referrer contact's first linked account).
            let referrerAccountId: string | null = offer.referrer_account_id || null
            if (!referrerAccountId && referrerContactId) {
              const { data: link } = await supabase
                .from("account_contacts")
                .select("account_id")
                .eq("contact_id", referrerContactId)
                .limit(1)
                .maybeSingle()
              referrerAccountId = (link as { account_id: string } | null)?.account_id ?? null
            }

            // Manual fallback task — used when we can't auto-credit, or it fails,
            // so a commission is never silently lost.
            const createReferralTask = (note: string) =>
              dbWriteSafe(
                // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw tasks.insert; extract to lib/operations/ per dev_task fda76fd3
                supabase.from("tasks").insert({
                  task_title: `Process referral commission — ${offer.referrer_name} → ${activation.client_name} (${commissionAmount ? `${commissionAmount} ${commissionCurrency}` : "TBD"})`,
                  assigned_to: "Antonio",
                  category: "Payment",
                  priority: "Normal",
                  status: "To Do",
                  account_id: autoAccountId || null,
                  description: `Referral by ${offer.referrer_name} (${offer.referrer_type || "client"}).${note ? ` ${note}` : ""} Commission: ${commissionType} — ${commissionAmount || "TBD"} ${commissionCurrency}. Offer: ${activation.offer_token}.`,
                }),
                "tasks.insert"
              )

            const decision = decideReferralAutoCredit({ commissionAmount, referrerAccountId })

            if (decision.autoCredit && referrerAccountId) {
              // f. Auto-issue the referrer's reward credit note (USD), idempotent per referral.
              try {
                await issueReferralCreditNote(
                  {
                    referralId: referral.id,
                    referrerAccountId,
                    amount: commissionAmount as number,
                    currency: commissionCurrency,
                    description: commissionType === "price_difference"
                      ? "Referral reward — partner commission"
                      : `Referral reward — ${commissionPct ?? 10}% credit`,
                  },
                  supabase
                )
                referralNoteLine = `📎 Referral credited: ${offer.referrer_name} — ${commissionAmount} ${commissionCurrency}`
                steps.push({ step: "referral", status: "credited", detail: `Referral ${referral.id.slice(0, 8)} auto-credited ${commissionAmount} ${commissionCurrency} to ${offer.referrer_name}` })
              } catch (creditErr) {
                await createReferralTask("⚠️ Auto-credit failed — issue the credit manually.")
                referralNoteLine = `📎 Referral (manual — auto-credit failed): ${offer.referrer_name} — ${commissionAmount || "TBD"} ${commissionCurrency}`
                steps.push({ step: "referral", status: "error", detail: `Auto-credit failed for ${referral.id.slice(0, 8)}, manual task created: ${creditErr instanceof Error ? creditErr.message : String(creditErr)}` })
              }
            } else {
              // No referrer account or zero amount → keep the manual task path.
              await createReferralTask("")
              referralNoteLine = `📎 Referral: ${offer.referrer_name} (${offer.referrer_type || "client"}) — commission ${commissionAmount || "TBD"} ${commissionCurrency} (manual: ${decision.reason})`
              steps.push({ step: "referral", status: "created", detail: `Referral ${referral.id.slice(0, 8)} → manual task (${decision.reason})` })
            }
          }
        }
      } else {
        steps.push({ step: "referral", status: "error", detail: "Could not find or create referrer contact" })
      }
    } else if (offer?.referrer_name && offer?.partner_id) {
      // Managed-partner offer: compensation runs through the partner-payout path
      // (Step 3.6). Skip the generic referral credit so the partner isn't paid twice.
      steps.push({ step: "referral", status: "skipped", detail: "Referral handled by partner-payout path (offer has partner_id) — referral credit skipped to avoid double-pay" })
    } else {
      steps.push({ step: "referral", status: "skipped", detail: "No referral on this offer" })
    }
  } catch (e) {
    steps.push({ step: "referral", status: "error", detail: `Referral step failed: ${e instanceof Error ? e.message : String(e)}` })
  }

  // ─── STEP 3.5b: Client referral credit (auto credit note on payment) ──────
  // Calendly-link referrals are tracked in `referrals` (pending, keyed by the
  // referred lead). Payment is now received, so convert the pending referral and
  // auto-issue the referrer's 10% credit note. Additive + non-blocking, and
  // independent of Step 3.5 (which handles offer.referrer_name partner/manual refs).
  try {
    if (leadId) {
      let setupFeeTotal = 0
      try {
        const costSummary = Array.isArray(offer?.cost_summary) ? offer.cost_summary : []
        if (costSummary.length > 0) {
          const firstSection = costSummary[0] as { total?: string }
          if (firstSection.total) {
            setupFeeTotal = Number(String(firstSection.total).replace(/[€$,.\s]/g, (m) => m === "," ? "" : m === "." ? "." : "")) || 0
            if (setupFeeTotal > 100000) setupFeeTotal = setupFeeTotal / 100
          }
        }
      } catch { /* parse failed; setupFeeTotal stays 0 */ }

      const creditRes = await creditReferrerForLead(
        {
          referredLeadId: leadId,
          referredContactId: contactId,
          referredAccountId: autoAccountId,
          setupFeeTotal,
          currency: "USD", // reward always USD so it nets against USD installments (Antonio 2026-05-27)
        },
        supabase
      )
      const creditDetail = creditRes.issued
        ? `Credit ${creditRes.amount} EUR issued to referrer (referral ${(creditRes.referralId ?? "").slice(0, 8)})`
        : `No credit: ${creditRes.reason ?? "unknown"}`
      steps.push({
        step: "client_referral_credit",
        status: creditRes.issued ? "created" : "skipped",
        detail: creditDetail,
      })
    }
  } catch (e) {
    steps.push({ step: "client_referral_credit", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── STEP 3.6: Partner Payout (Phase 3B, AUTO, non-blocking) ──────
  // Fires when an offer carries partner_id (managed-partner-driven offer)
  // and partner_payout_model is set to a non-'none' value. Independent
  // from Step 3.5 (legacy per-deal referrals) — both can run for the same
  // offer if it was both referred AND originated by a managed partner.
  //
  // Writes a row to referral_payouts with status='pending'. Admin reviews
  // in the CRM partner detail page and clicks Approve / Mark Paid.
  try {
    if (offer?.partner_id && offer.partner_payout_model && offer.partner_payout_model !== "none") {
      const { calculatePartnerPayout } = await import("@/lib/partners/payout-calc")

      // Read partner's td_base_costs map for the price_difference model.
      const { data: partnerRow } = await supabase
        .from("client_partners")
        .select("td_base_costs, partner_name")
        .eq("id", offer.partner_id)
        .single()

      // Resolve service slug used on this offer — the partner request
      // endpoint stores it as services[0].slug. Falls back to the first
      // bundled_pipeline label, lowercased, if slug is missing.
      const offerServices = Array.isArray(offer.services) ? offer.services as Array<Record<string, unknown>> : []
      const primarySlug = (offerServices[0]?.slug as string | undefined) || null
      const tdBaseCosts = (partnerRow?.td_base_costs ?? {}) as Record<string, number>
      const tdBaseCost = primarySlug ? (Number(tdBaseCosts[primarySlug]) || null) : null

      const paymentAmount = Number(activation.amount) || 0
      const result = calculatePartnerPayout({
        model: offer.partner_payout_model as Parameters<typeof calculatePartnerPayout>[0]["model"],
        rate: offer.partner_payout_rate != null ? Number(offer.partner_payout_rate) : null,
        paymentAmount,
        tdBaseCost,
      })

      // Referrer/partner payouts are ALWAYS USD — clients pay in EUR but we pay
      // partners the figure directly in USD, no FX (Antonio 2026-06-25). For
      // price_difference this takes the EUR-magnitude diff directly as USD,
      // matching the referral-credit rule.
      const payoutCurrency = "USD"
      const payoutStatus = result.error ? "manual_review" : "pending"

      const { data: payoutRow, error: payoutErr } = await dbWriteSafe(
        supabase
          .from("referral_payouts")
          // eslint-disable-next-line no-restricted-syntax -- new referral_payouts columns (offer_token/account_id/contact_id) not yet in generated types; cast until prod migration + regen
          .insert({
            partner_id: offer.partner_id,
            referral_id: null,
            payout_type: offer.partner_payout_model,
            amount: result.amount ?? 0,
            currency: payoutCurrency,
            payment_id: paymentIdForPayout,
            status: payoutStatus,
            notes: result.note || null,
            // Flexible referral anchor — the offer works for COMPANY or INDIVIDUAL referrals.
            offer_token: activation.offer_token,
            account_id: autoAccountId || null,
            contact_id: contactId || null,
          } as never)
          .select("id")
          .single(),
        "referral_payouts.insert"
      )

      if (payoutErr) {
        steps.push({ step: "partner_payout", status: "error", detail: `Insert failed: ${payoutErr}` })
      } else {
        // No CRM task — the partner self-serves the payout request from their
        // portal (My Referrals); staff approve & pay in CRM → Partners.
        steps.push({
          step: "partner_payout",
          status: result.error ? "manual_review" : "created",
          detail: `Payout ${payoutRow?.id?.slice(0, 8)}: ${offer.partner_payout_model} ${result.amount ?? "—"} ${payoutCurrency}${result.error ? ` (${result.error})` : ""}`,
        })
      }

      // Persist the durable partner deal + link on the account so the recurring
      // renewal payout (Slice 2, years later) knows the partner and the renewal
      // share. partner_renewal_payout / partner_deal are new columns — cast
      // until the migration is promoted to prod and types regenerate.
      const renewalPayout = (offer as { partner_renewal_payout?: number | string | null }).partner_renewal_payout
      const partnerDeal = buildPartnerDeal({
        partnerId: offer.partner_id,
        setupPayout: result.amount,
        renewalPayout: renewalPayout != null ? Number(renewalPayout) : null,
        currency: payoutCurrency,
        offerToken: activation.offer_token,
      })
      if (autoAccountId && partnerDeal) {
        await dbWriteSafe(
          // eslint-disable-next-line no-restricted-syntax -- new columns not yet in generated types (sandbox-applied, prod pending); cast until regen
          supabase.from("accounts").update({
            partner_id: offer.partner_id,
            partner_deal: partnerDeal,
            updated_at: new Date().toISOString(),
          } as Record<string, unknown> as never).eq("id", autoAccountId),
          "accounts.partner_deal",
        )
        steps.push({ step: "partner_deal", status: "created", detail: `Deal saved on ${autoAccountId.slice(0, 8)}: setup ${partnerDeal.setup_payout ?? "—"} / renewal ${partnerDeal.renewal_payout ?? "—"} ${partnerDeal.currency}` })
      }
    } else if (offer?.partner_id) {
      // Renewal-only deal (no setup payout): still persist the partner link + deal
      // so the recurring renewal payout fires in later years.
      const renewalOnly = (offer as { partner_renewal_payout?: number | string | null }).partner_renewal_payout
      const renewalDeal = buildPartnerDeal({
        partnerId: offer.partner_id,
        setupPayout: null,
        renewalPayout: renewalOnly != null ? Number(renewalOnly) : null,
        currency: "USD",
        offerToken: activation.offer_token,
      })
      if (autoAccountId && renewalDeal) {
        await dbWriteSafe(
          // eslint-disable-next-line no-restricted-syntax -- new columns not yet in generated types; cast until prod migration + regen
          supabase.from("accounts").update({
            partner_id: offer.partner_id,
            partner_deal: renewalDeal,
            updated_at: new Date().toISOString(),
          } as Record<string, unknown> as never).eq("id", autoAccountId),
          "accounts.partner_deal",
        )
        steps.push({ step: "partner_payout", status: "skipped", detail: `payout_model='none' — renewal-only deal saved (renewal ${renewalDeal.renewal_payout} ${renewalDeal.currency})` })
      } else {
        steps.push({ step: "partner_payout", status: "skipped", detail: "Partner present but payout_model='none'" })
      }
    } else {
      steps.push({ step: "partner_payout", status: "skipped", detail: "No partner on this offer" })
    }
  } catch (e) {
    steps.push({ step: "partner_payout", status: "error", detail: `Partner payout step failed: ${e instanceof Error ? e.message : String(e)}` })
  }

  // ─── STEP 4: Data Collection Form (SUPERVISED) ──────────
  const formConfig = FORM_CONFIG[contractType]
  if (formConfig && leadId) {
    const { data: lead } = await supabase
      .from("leads")
      .select("language, full_name, email")
      .eq("id", leadId)
      .single()

    if (lead) {
      // Check if form already exists
      const { data: existingForm } = await supabase
        .from(formConfig.table as never)
        .select("token")
        .eq(formConfig.leadIdField, leadId)
        .limit(1)

      if (existingForm && existingForm.length > 0) {
        steps.push({ step: "data_form", status: "existing", detail: `${formConfig.formName} already exists: ${(existingForm[0] as Record<string, unknown>).token}` })
      } else {
        const formLang = lead.language === "Italian" || lead.language === "it" ? "it" : "en"

        // Phase 0 safety: derive entity_type from the signed contract instead of hardcoding "SMLLC".
        // For formation + onboarding: read contracts.llc_type (SMLLC | MMLLC | Corporation).
        // For other contract types: entity_type stays undefined (wizard collects it).
        const entityTypeLookup = (contractType === "formation" || contractType === "onboarding")
          ? await getEntityTypeFromContract(activation.offer_token)
          : null

        // If the client signed as Corporation, the wizard form doesn't have a C-Corp path yet.
        // Skip auto-wizard creation and create a manual-handling task instead (surfaced via steps[]).
        if ((contractType === "formation" || contractType === "onboarding") && entityTypeLookup?.source === "corporation_not_wired") {
          steps.push({
            step: "data_form",
            status: "manual_required",
            detail: `Client signed as C-Corp — formation wizard not wired for Corporation. Manual handling required for ${lead.full_name} (${lead.email}).`,
          })
        } else {
          // Preferred entity_type from signed contract (SMLLC or MMLLC).
          // Legacy fallback to "SMLLC" for formation/onboarding when no contract was found.
          const entityTypeForForm: string | undefined = (contractType === "formation" || contractType === "onboarding")
            ? (entityTypeLookup?.wizardCode ?? "SMLLC")
            : undefined

          preparedSteps.push({
            step: "data_form",
            action: formConfig.action,
            description: `Create ${formConfig.formName} for ${lead.full_name} (${formLang}) and send link to ${lead.email}.`,
            params: {
              lead_id: leadId,
              contract_type: contractType,
              entity_type: entityTypeForForm,
              state: contractType === "formation" ? "NM" : undefined,
              language: formLang,
              client_name: lead.full_name,
              client_email: lead.email,
            },
            status: "pending",
          })
        }
      }
    }
  } else if (!formConfig) {
    steps.push({ step: "data_form", status: "skipped", detail: `No form config for contract_type: ${contractType}` })
  } else {
    steps.push({ step: "data_form", status: "skipped", detail: "No lead_id available" })
  }

  // ─── Always auto-execute all prepared steps ──────────────
  if (preparedSteps.length > 0) {
    for (const ps of preparedSteps) {
      steps.push({ step: ps.step, status: "auto_queued", detail: `Auto mode: ${ps.description}` })
      ps.status = "confirmed"
    }
  }

  await dbWrite(
    supabase
      .from("pending_activations")
      .update({
        status: "activated",
        prepared_steps: preparedSteps.length > 0 ? preparedSteps as unknown as Json : null,
        confirmation_mode: "auto",
        activated_at: new Date().toISOString(),
        // Stamp payment_confirmed_at if the caller didn't. Stripe/Whop/confirm-
        // payment/bank-feed all set it BEFORE calling runActivation (the `??`
        // preserves theirs); but some manual/bank-transfer paths activated
        // without it, leaving the client journey stuck on "Awaiting Payment"
        // despite being paid + activated (Michele Cotti, 2026-06-10). An
        // activation means payment was confirmed — EXCEPT the deliberately
        // payment-decoupled "Activate Now" path (payment_method='none'), which
        // must stay unpaid for AR/dunning.
        payment_confirmed_at:
          activation.payment_confirmed_at ??
          (activation.payment_method === "none" ? null : new Date().toISOString()),
        updated_at: new Date().toISOString(),
      })
      .eq("id", pending_activation_id),
    "pending_activations.update"
  )

  // ─── STEP 4b: Mark offer as completed (AUTO) ──────────
  // Stripe webhook already does this (stripe/route.ts:328-334), but wire-paid
  // and admin-confirmed cases skip the Stripe webhook, so we handle it here
  // to ensure offer completion for ALL payment paths.
  if (activation.offer_token) {
    const { error: offerUpdErr } = await dbWriteSafe(
      supabase
        .from("offers")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("token", activation.offer_token)
        .eq("status", "signed"), // Only update signed → completed, not other statuses
      "offers.update"
    )
    if (!offerUpdErr) {
      steps.push({ step: "offer_completion", status: "done", detail: `Offer ${activation.offer_token} → completed` })
    } else {
      // May fail if already completed (e.g., Stripe webhook ran first) — that's fine
      steps.push({ step: "offer_completion", status: "skipped", detail: "Offer not in 'signed' status (may already be completed)" })
    }
  }

  // ─── STEP 4c: Flip lead to Converted ─────────────────────
  // Lives here so it fires regardless of which caller triggered the activation
  // (confirm-payment, Stripe, Whop, retry, etc.). The .neq guard makes it
  // idempotent — no-op if the lead is already Converted.
  if (leadId) {
    const { data: flippedRows } = await dbWriteSafe(
      supabase
        .from("leads")
        .update({ status: "Converted", updated_at: new Date().toISOString() })
        .eq("id", leadId)
        .neq("status", "Converted")
        .select("id"),
      "leads.update"
    )
    const wasFlipped = Array.isArray(flippedRows) && flippedRows.length > 0
    steps.push({
      step: "lead_converted",
      status: "done",
      detail: wasFlipped
        ? `Lead ${leadId.slice(0, 8)} → Converted`
        : `Lead ${leadId.slice(0, 8)} already Converted`,
    })
  }

  // ─── STEP 5: Notify Luca + Antonio via email ──────────
  try {
    const { gmailPost } = await import("@/lib/gmail")

    // For onboarding: pull submission data to enrich the email
    let sub: Record<string, unknown> = {}
    if (contractType === "onboarding" && contactId) {
      const { data: submission } = await supabase
        .from("onboarding_submissions")
        .select("submitted_data")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (submission?.submitted_data) sub = submission.submitted_data as Record<string, unknown>
    }

    const str = (v: unknown) => (v ? String(v) : "")
    const row = (label: string, value: unknown) => value
      ? `<tr><td style="padding:6px 12px;font-weight:bold;color:#6b7280;font-size:12px;width:38%;text-transform:uppercase;letter-spacing:0.03em">${label}</td><td style="padding:6px 12px;font-size:14px;color:#111827">${String(value)}</td></tr>`
      : ""
    const section = (title: string, rows: string) => rows.trim()
      ? `<p style="margin:24px 0 6px;font-size:11px;font-weight:bold;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">${title}</p><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">${rows}</table>`
      : ""

    const paidDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    const serviceLabel = contractType === "formation" ? "LLC Formation"
      : contractType === "onboarding" ? "LLC Onboarding"
      : contractType === "tax_return" ? "Tax Return"
      : contractType === "itin" ? "ITIN Application"
      : contractType

    const paymentSection = section("Payment", [
      row("Client", activation.client_name),
      row("Email", activation.client_email),
      row("Service", serviceLabel),
      row("Amount", `${activation.currency} ${activation.amount}`),
      row("Payment method", activation.payment_method),
      row("Date", paidDate),
      referralNoteLine ? row("Referral", referralNoteLine) : "",
    ].join(""))

    const ownerSection = contractType === "onboarding" ? section("Owner", [
      row("Full name", `${str(sub.owner_first_name)} ${str(sub.owner_last_name)}`.trim()),
      row("Email", str(sub.owner_email)),
      row("Phone", str(sub.owner_phone)),
      row("Date of birth", str(sub.owner_dob)),
      row("Nationality", str(sub.owner_nationality)),
      row("Address", [sub.owner_street, sub.owner_city, sub.owner_state_province, sub.owner_zip, sub.owner_country].filter(Boolean).join(", ")),
    ].join("")) : ""

    const companySection = contractType === "onboarding" ? section("Company", [
      row("Name", str(sub.company_name)),
      row("State", str(sub.state_of_formation)),
      row("Formation date", str(sub.formation_date)),
      row("EIN", str(sub.ein)),
      row("Filing ID", str(sub.filing_id)),
      row("Business purpose", str(sub.business_purpose)),
      row("Current registered agent", str(sub.registered_agent)),
    ].join("")) : ""

    const taxSection = contractType === "onboarding" ? section("Tax history", [
      row("Previous year filed", str(sub.tax_return_previous_year_filed)),
      row("Current year filed", str(sub.tax_return_current_year_filed)),
    ].join("")) : ""

    const nextStep = contractType === "onboarding"
      ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin:28px 0 0"><p style="margin:0;font-size:13px;font-weight:600;color:#1e40af">Next step</p><p style="margin:4px 0 0;font-size:13px;color:#1d4ed8">Luca — Registered Agent change: ${str(sub.company_name) || activation.client_name}</p></div>`
      : ""

    const inner = `${paymentSection}${ownerSection}${companySection}${taxSection}${nextStep}`
    const emailBody = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#2563eb;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="color:white;margin:0;font-size:20px">Tony Durante LLC</h1>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px">New Client</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    ${inner}
    <div style="border-top:1px solid #e5e7eb;margin-top:24px;padding-top:12px;font-size:11px;color:#9ca3af">Tony Durante LLC · 10225 Ulmerton Rd, STE 3D, Largo FL 33771</div>
  </div>
</div>`

    const activationSubject = `New client: ${activation.client_name} — ${serviceLabel}`
    const encodedSubject = `=?utf-8?B?${Buffer.from(activationSubject).toString("base64")}?=`
    const raw = Buffer.from(
      `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
      `To: support@tonydurante.us\r\n` +
      `Cc: antonio.durante@tonydurante.us\r\n` +
      `Subject: ${encodedSubject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n` +
      emailBody
    ).toString("base64url")

    await gmailPost("/messages/send", { raw })
    steps.push({ step: "team_notification", status: "ok", detail: "Email sent to support@ + antonio@" })
  } catch (e) {
    steps.push({ step: "team_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // Log action
  await dbWriteSafe(
    supabase.from("action_log").insert({
      action_type: "service_activated",
      table_name: "pending_activations",
      record_id: pending_activation_id,
      summary: `Service activated: ${contractType} (${isAutoMode ? "auto" : "supervised"})`,
      details: {
        steps,
        contract_type: contractType,
        bundled_pipelines: pipelines,
        service_deliveries: sdResults,
        prepared_steps: preparedSteps.length,
        mode: isAutoMode ? "auto" : "supervised",
        lead_id: leadId,
        contact_id: contactId,
      } as unknown as Json,
    }),
    "action_log.insert"
  )

  // eslint-disable-next-line no-console -- observability log
  console.log(`[activate-service] ${contractType.toUpperCase()} | ${isAutoMode ? "AUTO" : "SUPERVISED"} | ${activation.client_name} | ${pipelines.length} pipelines`)

  return {
    ok: true,
    contract_type: contractType,
    mode: isAutoMode ? "auto" : "supervised",
    steps,
    service_deliveries: sdResults,
    prepared_steps: preparedSteps.length,
  }
}
