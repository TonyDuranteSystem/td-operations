/**
 * Activate Service — Universal Post-Payment Automation
 *
 * Triggered when payment is confirmed (Whop webhook or wire cron).
 * Handles ALL contract types: formation, onboarding, tax_return, itin.
 *
 * Steps:
 *   1.   Lead → Contact (AUTO)
 *   1.5  Ensure minimal account for formation/onboarding (AUTO)
 *   2.   Create service deliveries from bundled_pipelines (AUTO)
 *   2b.  Portal tier upgrade: lead → onboarding (AUTO)
 *   2c.  Auto-create portal user + welcome email (AUTO)
 *   3.   CRM Invoice + QB sync (AUTO — replaces old direct QB creation)
 *   4.   Send appropriate data collection form based on contract_type (SUPERVISED)
 *
 * Supervised steps saved in prepared_steps JSONB.
 * Claude confirms via MCP before execution.
 * After 5 successful confirmations → auto mode.
 */

// Added 2026-04-14 P0.7: protect complex bundled activations (15+ sequential
// steps) from mid-execution Vercel timeout. Without this, a partial failure
// left clients half-activated with no visible alert.
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { ensureMinimalAccount, autoCreatePortalUser, sendPortalWelcomeEmail } from "@/lib/portal/auto-create"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { syncInvoiceStatus } from "@/lib/portal/unified-invoice"
import { syncInvoiceToQB, syncPaymentToQB } from "@/lib/qb-sync"
import { createPortalNotification } from "@/lib/portal/notifications"
import { calculateCommission } from "@/lib/referral-utils"
import { findTaxReturnService } from "@/lib/tax-return-context"

// Auto-execute all steps immediately. Previous supervised mode with threshold
// silently blocked Valerio Sicari and Antonio Truocchio — pending_activations stayed
// at payment_confirmed with empty prepared_steps and no notification.
const AUTO_MODE_ALWAYS = true

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

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const authHeader = req.headers.get("authorization")
    const token = authHeader?.replace("Bearer ", "")
    if (token !== process.env.API_SECRET_TOKEN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await req.json()
    const { pending_activation_id } = body

    if (!pending_activation_id) {
      return NextResponse.json({ error: "Missing pending_activation_id" }, { status: 400 })
    }

    // Get pending activation
    const { data: activation, error: actErr } = await supabase
      .from("pending_activations")
      .select("*")
      .eq("id", pending_activation_id)
      .single()

    if (actErr || !activation) {
      return NextResponse.json({ error: "Activation not found" }, { status: 404 })
    }

    if (activation.status === "activated") {
      return NextResponse.json({ ok: true, message: "Already activated" })
    }

    // Get the offer to determine contract_type and bundled_pipelines
    const { data: offer } = await supabase
      .from("offers")
      .select("contract_type, bundled_pipelines, account_id, selected_services, services, client_name, cost_summary, referrer_name, referrer_type, referrer_email, referrer_commission_type, referrer_commission_pct, referrer_agreed_price, referrer_account_id")
      .eq("token", activation.offer_token)
      .single()

    const contractType = offer?.contract_type || "formation"

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
            const { data: newContact, error: cErr } = await supabase
              .from("contacts")
              .insert({
                full_name: lead.full_name,
                email: lead.email,
                phone: lead.phone,
                language: lead.language === "Italian" ? "it" : "en",
              })
              .select()
              .single()

            if (newContact) {
              contactId = newContact.id
              steps.push({ step: "lead_to_contact", status: "created", detail: `Contact created: ${contactId}` })
            } else {
              steps.push({ step: "lead_to_contact", status: "error", detail: cErr?.message })
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
            const { data: newContact } = await supabase
              .from("contacts")
              .insert({
                full_name: leads[0].full_name,
                email: leads[0].email,
                phone: leads[0].phone,
                language: leads[0].language === "Italian" ? "it" : "en",
              })
              .select()
              .single()
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

    // ─── STEP 1.5: Ensure Minimal Account (AUTO, formation/onboarding) ──
    let autoAccountId: string | null = offer?.account_id || null
    let isStandaloneBusinessTR = false

    if (!autoAccountId && contactId && (contractType === "formation" || contractType === "onboarding")) {
      const accountResult = await ensureMinimalAccount({
        contactId,
        clientName: activation.client_name,
        contractType,
        offerToken: activation.offer_token,
        leadId: leadId || undefined,
      })
      if (accountResult.accountId) {
        autoAccountId = accountResult.accountId
        steps.push({
          step: "ensure_account",
          status: accountResult.created ? "created" : "existing",
          detail: `Account ${accountResult.accountId.slice(0, 8)} (${accountResult.created ? "auto-created" : "already linked"})`,
        })
      } else {
        steps.push({ step: "ensure_account", status: "error", detail: accountResult.error })
      }
    } else if (!autoAccountId && contactId) {
      // For other contract types: check if any pipeline is business-context
      const offerPipelines: string[] = Array.isArray(offer?.bundled_pipelines) ? offer.bundled_pipelines : []
      const offerServices = Array.isArray(offer?.services) ? offer.services : null
      const businessContextResult = hasBusinessContextPipeline(offerPipelines, offerServices, activation.offer_token)

      if (businessContextResult === 'ambiguous') {
        return NextResponse.json({
          ok: false,
          error: "Tax Return activation requires explicit service_context (business or individual) on the offer. Update the offer's services[] before retrying activation.",
          steps,
        }, { status: 400 })
      }

      if (businessContextResult === 'multiple_matches') {
        return NextResponse.json({
          ok: false,
          error: "Tax Return activation blocked — offer has multiple Tax Return service entries. Update the offer to have exactly one.",
          steps,
        }, { status: 400 })
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
        const { data: lead } = await supabase.from("leads").select("account_id").eq("id", leadId).maybeSingle()
        autoAccountId = lead?.account_id || null
      }
    }

    // ─── STEP 1.6: Auto-upgrade account_type if offer has annual services ──
    if (autoAccountId && (contractType === "formation" || contractType === "onboarding")) {
      const { data: currentAcct } = await supabase
        .from("accounts")
        .select("account_type")
        .eq("id", autoAccountId)
        .single()

      if (currentAcct && currentAcct.account_type !== "Client") {
        await supabase
          .from("accounts")
          .update({ account_type: "Client", updated_at: new Date().toISOString() })
          .eq("id", autoAccountId)
        steps.push({
          step: "upgrade_account_type",
          status: "done",
          detail: `Account type changed from "${currentAcct.account_type}" to "Client" (annual management offer)`,
        })
      }
    }

    // ─── STEP 2: Service Deliveries from bundled_pipelines (AUTO) ─────
    const sdResults: Array<{ pipeline: string; status: string; id?: string }> = []
    const pipelines: string[] = Array.isArray(offer?.bundled_pipelines) ? offer.bundled_pipelines : []

    if (pipelines.length > 0) {
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
              auto_tasks: Array.isArray(s.auto_tasks) ? s.auto_tasks : [],
            })
          }
        }
      }

      // Use autoAccountId (may have been created in Step 1.5)
      const accountId = autoAccountId

      for (const pipeline of pipelines) {
        try {
          // Check if service delivery already exists for this offer + pipeline
          const { data: existingSd } = await supabase
            .from("service_deliveries")
            .select("id")
            .eq("service_type", pipeline)
            .ilike("notes", `%${activation.offer_token}%`)
            .limit(1)

          if (existingSd && existingSd.length > 0) {
            sdResults.push({ pipeline, status: "existing", id: existingSd[0].id })
            continue
          }

          // Secondary guard: same service_type already active on this account
          // (catches SDs created by other paths without offer token in notes)
          if (accountId) {
            const { data: activeSd } = await supabase
              .from("service_deliveries")
              .select("id")
              .eq("service_type", pipeline)
              .eq("account_id", accountId)
              .eq("status", "active")
              .limit(1)
            if (activeSd && activeSd.length > 0) {
              sdResults.push({ pipeline, status: "existing", id: activeSd[0].id })
              continue
            }
          }

          // Tax Return has context-dependent entry points — never use generic firstStage
          let stage: string
          let explicitStageOrder: number | null = null
          if (pipeline === "Tax Return") {
            if (isStandaloneBusinessTR) {
              stage = "Company Data Pending"
              explicitStageOrder = -1
            } else {
              stage = "1st Installment Paid"
            }
          } else {
            stage = firstStage.get(pipeline) || "Pending"
          }

          const { data: sd, error: sdErr } = await supabase
            .from("service_deliveries")
            .insert({
              service_type: pipeline,
              service_name: `${pipeline} - ${activation.client_name}`,
              account_id: isStandaloneBusinessTR && pipeline === "Tax Return" ? null : accountId,
              contact_id: contactId,
              stage: stage,
              stage_order: explicitStageOrder,
              status: "active",
              assigned_to: "Luca",
              notes: `Auto-created from offer ${activation.offer_token}`,
            })
            .select("id")
            .single()

          if (sdErr) {
            sdResults.push({ pipeline, status: "error", id: sdErr.message })
          } else {
            sdResults.push({ pipeline, status: "created", id: sd?.id })

            // Auto-create tasks from pipeline_stages.auto_tasks (mirrors sd_create logic)
            const stageData = firstStageData.get(pipeline)
            if (sd?.id && stageData?.auto_tasks?.length) {
              const serviceName = `${pipeline} - ${activation.client_name}`
              for (const taskDef of stageData.auto_tasks) {
                await supabase.from("tasks").insert({
                  task_title: `[${serviceName}] ${taskDef.title}`,
                  assigned_to: taskDef.assigned_to || "Luca",
                  category: taskDef.category || "Internal",
                  priority: taskDef.priority || "Normal",
                  description: "Auto-created on service delivery creation",
                  status: "To Do",
                  account_id: accountId,
                  delivery_id: sd.id,
                  stage_order: stageData.stage_order,
                })
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
          await supabase
            .from("tax_returns")
            .update({ paid: true, paid_date: today })
            .eq("id", existingTr[0].id)
          steps.push({ step: "tax_return_paid", status: "updated", detail: `tax_returns ${existingTr[0].id.slice(0, 8)} marked paid (included in deal)` })
        } else {
          steps.push({ step: "tax_return_paid", status: "skipped", detail: `No tax_returns record found for ${currentYear - 1}` })
        }
      }
    }

    // ─── STEP 2b: Portal tier upgrade (AUTO) ─────────────────
    // Upgrade portal tier from lead → onboarding after payment (syncs account + contacts)
    if (autoAccountId) {
      // Business-context: upgrade via account (syncs account + all linked contacts + auth users)
      const { upgradePortalTier } = await import("@/lib/portal/auto-create")
      const tierResult = await upgradePortalTier(autoAccountId, "onboarding")
      const tierAlreadyAtOrAbove = ['onboarding', 'active', 'full'].includes(tierResult.previousTier || '')
      steps.push({ step: "portal_tier_upgrade", status: tierResult.success ? "done" : "error", detail: tierResult.success ? (tierAlreadyAtOrAbove ? `Already ${tierResult.previousTier} (no change)` : `${tierResult.previousTier || "lead"} → onboarding (via account)`) : (tierResult.error || "Unknown error") })
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
        const tierOrder = ["lead", "onboarding", "active", "full"]
        const currentIdx = tierOrder.indexOf(currentTier)
        const newIdx = tierOrder.indexOf("onboarding")

        if (newIdx > currentIdx) {
          // 1. Update contacts.portal_tier
          await supabase
            .from("contacts")
            .update({ portal_tier: "onboarding" })
            .eq("id", contactId)

          // 2. Update auth.users.app_metadata.portal_tier (same pattern as upgradePortalTier)
          if (currentContact?.email) {
            const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 })
            const authUser = users.find((u: { email?: string }) => u.email === currentContact.email)
            if (authUser) {
              await supabase.auth.admin.updateUserById(authUser.id, {
                app_metadata: { ...authUser.app_metadata, portal_tier: "onboarding" },
              })
            }
          }

          steps.push({ step: "portal_tier_upgrade", status: "done", detail: `${currentTier} → onboarding (contact-only, no account)` })
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
        tier: "onboarding",
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

      // Push notification: new service ready
      if (autoAccountId && pipelines.length > 0) {
        createPortalNotification({
          account_id: autoAccountId,
          contact_id: contactId || undefined,
          type: "service",
          title: "Welcome! Your service is being set up",
          body: `We're preparing your ${pipelines[0]} service. Check the portal for next steps.`,
          link: "/portal",
        }).catch(() => {})
      }
    } else {
      steps.push({ step: "portal_user", status: "skipped", detail: "No contact_id available" })
    }

    // ─── STEP 3: Unified Invoice + QB Sync (AUTO) ──────────
    // Creates in BOTH client_invoices (portal) and payments (CRM), linked by FK
    // DEDUP: If offer-signed already created an invoice (portal_invoice_id on activation), skip creation and just mark it Paid
    if (activation.portal_invoice_id) {
      // Invoice already created at signing — just mark it Paid now
      try {
        const today = new Date().toISOString().split("T")[0]
        await syncInvoiceStatus("invoice", activation.portal_invoice_id, "Paid", today, Number(activation.amount) || undefined)

        // Backfill account_id on the existing invoice if we now have one
        if (autoAccountId) {
          await supabase
            .from("client_invoices")
            .update({ account_id: autoAccountId, updated_at: new Date().toISOString() })
            .eq("id", activation.portal_invoice_id)
            .is("account_id", null)

          // Also update the linked payment record
          const { data: linkedPay } = await supabase
            .from("payments")
            .select("id")
            .eq("portal_invoice_id", activation.portal_invoice_id)
            .limit(1)
            .maybeSingle()
          if (linkedPay) {
            await supabase
              .from("payments")
              .update({ account_id: autoAccountId, updated_at: new Date().toISOString() })
              .eq("id", linkedPay.id)
              .is("account_id", null)
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

        // QB sync (best-effort)
        const { data: linkedPayForQB } = await supabase
          .from("payments")
          .select("id")
          .eq("portal_invoice_id", activation.portal_invoice_id)
          .limit(1)
          .maybeSingle()
        if (linkedPayForQB) {
          syncInvoiceToQB(linkedPayForQB.id)
            .then((r) => {
              if (r.success && r.qb_invoice_id) {
                syncPaymentToQB(linkedPayForQB.id, {
                  paymentDate: today,
                  paymentMethod: activation.payment_method || "Whop",
                }).catch(() => {})
              }
            })
            .catch(() => {})
        }
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
          whop_payment_id: activation.whop_payment_id || null,
        })

        // Store payment reference on activation for traceability
        await supabase
          .from("pending_activations")
          .update({ portal_invoice_id: invoiceResult.paymentId })
          .eq("id", pending_activation_id)

        steps.push({
          step: "crm_invoice",
          status: "created",
          detail: `${invoiceResult.invoiceNumber} — ${activation.currency} ${amount} (Paid)`,
        })

        // QB sync (best-effort, non-blocking) — uses payment ID
        if (invoiceResult.paymentId) {
          syncInvoiceToQB(invoiceResult.paymentId)
            .then((r) => {
              if (r.success && r.qb_invoice_id) {
                syncPaymentToQB(invoiceResult.paymentId, {
                  paymentDate: today,
                  paymentMethod: activation.payment_method || "Whop",
                }).catch(() => {})
              }
            })
            .catch(() => {})
        }
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
      if (offer?.referrer_name) {
        // a. Find or create referrer contact
        let referrerContactId: string | null = null
        const { data: referrerContacts } = await supabase
          .from("contacts")
          .select("id")
          .ilike("full_name", offer.referrer_name)
          .limit(1)

        if (referrerContacts && referrerContacts.length > 0) {
          referrerContactId = referrerContacts[0].id
        } else {
          // Create minimal contact for the referrer
          const { data: newReferrer } = await supabase
            .from("contacts")
            .insert({
              full_name: offer.referrer_name,
              email: offer.referrer_email || null,
              referrer_type: offer.referrer_type || null,
            })
            .select("id")
            .single()
          referrerContactId = newReferrer?.id || null
        }

        if (referrerContactId) {
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

          // c. Determine commission type and calculate
          const commissionType = offer.referrer_commission_type
            || (offer.referrer_type === "partner" ? "price_difference" : "credit_note")
          const commissionPct = offer.referrer_commission_pct ?? (commissionType !== "price_difference" ? 10 : null)
          const commissionAmount = calculateCommission(
            commissionType,
            commissionPct,
            offer.referrer_agreed_price || null,
            setupFeeTotal,
            setupFeeTotal, // basePriceForState = full setup fee for price_difference calc
          )
          const commissionCurrency = "EUR"

          // d. Insert referral record
          const { data: referral, error: refErr } = await supabase
            .from("referrals")
            .insert({
              referrer_contact_id: referrerContactId,
              referrer_account_id: offer.referrer_account_id || null,
              referred_contact_id: contactId || null,
              referred_account_id: autoAccountId || null,
              referred_lead_id: leadId || null,
              referred_name: offer.client_name || activation.client_name,
              offer_token: activation.offer_token,
              status: "converted",
              commission_type: commissionType,
              commission_pct: commissionPct,
              commission_amount: commissionAmount || null,
              commission_currency: commissionCurrency,
            })
            .select("id")
            .single()

          if (refErr) {
            steps.push({ step: "referral", status: "error", detail: `Insert failed: ${refErr.message}` })
          } else {
            // e. Create follow-up task
            await supabase.from("tasks").insert({
              task_title: `Process referral commission — ${offer.referrer_name} → ${activation.client_name} (${commissionAmount ? `${commissionAmount} ${commissionCurrency}` : "TBD"})`,
              assigned_to: "Antonio",
              category: "Payment",
              priority: "Normal",
              status: "To Do",
              account_id: autoAccountId || null,
              description: `Referral by ${offer.referrer_name} (${offer.referrer_type || "client"}). Commission: ${commissionType} — ${commissionAmount || "TBD"} ${commissionCurrency}. Offer: ${activation.offer_token}.`,
            })

            // f. Info line for team notification email
            referralNoteLine = `📎 Referral: ${offer.referrer_name} (${offer.referrer_type || "client"}) — commission ${commissionAmount || "TBD"} ${commissionCurrency}`

            steps.push({
              step: "referral",
              status: "created",
              detail: `Referral ${referral?.id?.slice(0, 8)}: ${offer.referrer_name} → ${activation.client_name} | ${commissionType} ${commissionAmount || "TBD"} ${commissionCurrency}`,
            })
          }
        } else {
          steps.push({ step: "referral", status: "error", detail: "Could not find or create referrer contact" })
        }
      } else {
        steps.push({ step: "referral", status: "skipped", detail: "No referral on this offer" })
      }
    } catch (e) {
      steps.push({ step: "referral", status: "error", detail: `Referral step failed: ${e instanceof Error ? e.message : String(e)}` })
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
          .from(formConfig.table)
          .select("token")
          .eq(formConfig.leadIdField, leadId)
          .limit(1)

        if (existingForm && existingForm.length > 0) {
          steps.push({ step: "data_form", status: "existing", detail: `${formConfig.formName} already exists: ${existingForm[0].token}` })
        } else {
          const formLang = lead.language === "Italian" || lead.language === "it" ? "it" : "en"

          preparedSteps.push({
            step: "data_form",
            action: formConfig.action,
            description: `Create ${formConfig.formName} for ${lead.full_name} (${formLang}) and send link to ${lead.email}.`,
            params: {
              lead_id: leadId,
              contract_type: contractType,
              entity_type: contractType === "formation" ? "SMLLC" : undefined,
              state: contractType === "formation" ? "NM" : undefined,
              language: formLang,
              client_name: lead.full_name,
              client_email: lead.email,
            },
            status: "pending",
          })
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

    await supabase
      .from("pending_activations")
      .update({
        status: "activated",
        prepared_steps: preparedSteps.length > 0 ? preparedSteps : null,
        confirmation_mode: "auto",
        activated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", pending_activation_id)

    // ─── STEP 4b: Mark offer as completed (AUTO) ──────────
    // Stripe webhook already does this (stripe/route.ts:328-334), but wire-paid
    // and admin-confirmed cases skip the Stripe webhook, so we handle it here
    // to ensure offer completion for ALL payment paths.
    if (activation.offer_token) {
      const { error: offerUpdErr } = await supabase
        .from("offers")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("token", activation.offer_token)
        .eq("status", "signed") // Only update signed → completed, not other statuses
      if (!offerUpdErr) {
        steps.push({ step: "offer_completion", status: "done", detail: `Offer ${activation.offer_token} → completed` })
      } else {
        // May fail if already completed (e.g., Stripe webhook ran first) — that's fine
        steps.push({ step: "offer_completion", status: "skipped", detail: "Offer not in 'signed' status (may already be completed)" })
      }
    }

    // ─── STEP 5: Notify Luca + Antonio via email ──────────
    try {
      const { gmailPost } = await import("@/lib/gmail")
      const sdList = sdResults.map(r => `- ${r.pipeline}: ${r.status}${r.id ? ` (${r.id.slice(0,8)})` : ""}`).join("\n")
      const supervisedList = preparedSteps.map(p => `- ${p.description}`).join("\n")

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[NEW CLIENT] ${activation.client_name} -- Payment Confirmed</h2>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 8px;font-weight:bold">Contract type:</td><td style="padding:4px 8px">${contractType}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Amount:</td><td style="padding:4px 8px">${activation.currency} ${activation.amount}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Payment:</td><td style="padding:4px 8px">${activation.payment_method}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Email:</td><td style="padding:4px 8px">${activation.client_email}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Contact ID:</td><td style="padding:4px 8px">${contactId || "N/A"}</td></tr>
</table>

<h3>Service Deliveries Created</h3>
<pre style="background:#f3f4f6;padding:12px;border-radius:6px">${sdList || "None"}</pre>

${referralNoteLine ? `<h3>Referral</h3><p>${referralNoteLine}</p>` : ""}

${preparedSteps.length > 0 ? `<h3>Supervised Steps (awaiting confirmation)</h3>
<pre style="background:#fef3c7;padding:12px;border-radius:6px">${supervisedList}</pre>
<p>Use <code>formation_confirm(activation_id)</code> in Claude to review and execute these steps.</p>` : ""}

<p style="font-size:12px;color:#6b7280">Activation ID: ${pending_activation_id} | Offer: ${activation.offer_token}</p>
</div>`

      const activationSubject = `[NEW CLIENT] ${activation.client_name} -- ${contractType} -- Payment Confirmed`
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
    await supabase.from("action_log").insert({
      action_type: "service_activated",
      entity_type: "pending_activations",
      entity_id: pending_activation_id,
      details: {
        steps,
        contract_type: contractType,
        bundled_pipelines: pipelines,
        service_deliveries: sdResults,
        prepared_steps: preparedSteps.length,
        mode: isAutoMode ? "auto" : "supervised",
        lead_id: leadId,
        contact_id: contactId,
      },
    })

    // eslint-disable-next-line no-console -- API route log for observability
    console.log(`[activate-service] ${contractType.toUpperCase()} | ${isAutoMode ? "AUTO" : "SUPERVISED"} | ${activation.client_name} | ${pipelines.length} pipelines`)

    return NextResponse.json({
      ok: true,
      contract_type: contractType,
      mode: isAutoMode ? "auto" : "supervised",
      steps,
      service_deliveries: sdResults,
      prepared_steps: preparedSteps.length,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[activate-service] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
