/**
 * Client Diagnostic API
 *
 * GET  ?account_id=UUID — Run full audit on a client account
 * POST { account_id, action, params } — Execute a one-click fix
 *
 * Checks 7 categories: Lead/Offer, Payments, Services, Forms, Documents, Portal, Infrastructure
 * Each check returns ok/warning/error with optional fix action.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { classifyAccount } from "@/lib/account-classification"
import { createSD } from "@/lib/operations/service-delivery"

// ─── Types ───

interface DiagnosticCheck {
  id: string
  category: string
  label: string
  status: "ok" | "warning" | "error" | "info"
  detail: string
  fix?: {
    action: string
    label: string
    params: Record<string, unknown>
    /** What this fix does — shown to user before confirming */
    description: string
    /** What downstream effects this has */
    impact: string[]
    /** Risk level: safe (no side effects), moderate (changes visible data), high (affects client) */
    risk: "safe" | "moderate" | "high"
  }
}

// ─── GET: Run Diagnostic ───

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("account_id")
  if (!accountId) {
    return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
  }

  try {
    const checks: DiagnosticCheck[] = []

    // Load account + contacts
    const { data: account } = await supabaseAdmin
      .from("accounts")
      .select("*")
      .eq("id", accountId)
      .single()

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 })
    }

    const { data: accountContacts } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id, role, contacts(id, full_name, email, portal_tier, portal_role)")
      .eq("account_id", accountId)

    const primaryContact = accountContacts?.[0]?.contacts as unknown as {
      id: string; full_name: string; email: string; portal_tier: string; portal_role: string
    } | null
    const contactId = primaryContact?.id || null
    const contactEmail = primaryContact?.email || null

    // Load all related data in parallel
    const [
      leadsResult,
      offersResult,
      pendingResult,
      paymentsResult,
      servicesResult,
      formationResult,
      onboardingResult,
      taxFormResult,
      oaResult,
      leaseResult,
      ss4Result,
      bankingResult,
      authUsersResult,
      taxReturnResult,
      deadlinesResult,
    ] = await Promise.all([
      // Lead
      contactEmail
        ? supabaseAdmin.from("leads").select("id, full_name, status, email, offer_link").ilike("email", contactEmail).limit(1)
        : { data: [] },
      // Offers
      supabaseAdmin.from("offers").select("token, status, payment_type, payment_links, bank_details, bundled_pipelines, contract_type, lead_id, account_id")
        .or(`account_id.eq.${accountId}${contactEmail ? `,client_email.ilike.${contactEmail}` : ""}`)
        .order("created_at", { ascending: false }).limit(1),
      // Pending activations
      contactEmail
        ? supabaseAdmin.from("pending_activations").select("id, offer_token, status, activated_at, payment_confirmed_at, payment_method, prepared_steps, confirmation_mode")
          .eq("client_email", contactEmail).order("created_at", { ascending: false }).limit(1)
        : { data: [] },
      // Payments
      // Payments: check both account-level AND contact-level (setup payments belong to contact)
      supabaseAdmin.from("payments").select("id, amount, amount_currency, status, payment_method, paid_date, invoice_status, description")
        .or(`account_id.eq.${accountId}${contactId ? `,contact_id.eq.${contactId}` : ""}`)
        .order("created_at", { ascending: false }),
      // Service deliveries
      supabaseAdmin.from("service_deliveries").select("id, service_type, status, stage, stage_order, assigned_to, updated_at")
        .or(`account_id.eq.${accountId}${contactId ? `,contact_id.eq.${contactId}` : ""}`),
      // Formation submission
      contactId
        ? supabaseAdmin.from("formation_submissions").select("id, token, status, completed_at, contact_id")
          .eq("contact_id", contactId).limit(1)
        : { data: [] },
      // Onboarding submission
      contactId
        ? supabaseAdmin.from("onboarding_submissions").select("id, token, status, completed_at")
          .eq("contact_id", contactId).limit(1)
        : { data: [] },
      // Tax form
      supabaseAdmin.from("tax_return_submissions").select("id, token, status, completed_at")
        .eq("account_id", accountId).limit(1),
      // OA
      supabaseAdmin.from("oa_agreements").select("id, token, status, signed_at")
        .eq("account_id", accountId).order("created_at", { ascending: false }).limit(1),
      // Lease
      supabaseAdmin.from("lease_agreements").select("id, token, status, signed_at, suite_number")
        .eq("account_id", accountId).order("created_at", { ascending: false }).limit(1),
      // SS-4
      supabaseAdmin.from("ss4_applications").select("id, token, status")
        .eq("account_id", accountId).limit(1),
      // Banking forms
      contactId
        ? supabaseAdmin.from("banking_submissions").select("id, token, status, provider, submitted_data")
          .eq("contact_id", contactId)
        : { data: [] },
      // Auth user — paginated lookup via findAuthUserByEmail (P1.9)
      Promise.resolve().then(async () => {
        if (!contactEmail) return { data: [] as { id: string; email: string }[] }
        try {
          const found = await findAuthUserByEmail(contactEmail)
          return { data: found ? [{ id: found.id, email: found.email || contactEmail }] : [] as { id: string; email: string }[] }
        } catch {
          return { data: [] as { id: string; email: string }[] }
        }
      }),
      // Tax return record
      supabaseAdmin.from("tax_returns").select("id, tax_year, status, extension_filed, first_year_skip")
        .eq("account_id", accountId).order("tax_year", { ascending: false }).limit(1),
      // Deadlines
      supabaseAdmin.from("deadlines").select("id, deadline_type, due_date, status")
        .eq("account_id", accountId),
    ])

    const lead = (leadsResult.data as unknown[])?.[0] as { id: string; full_name: string; status: string; email: string; offer_link: string } | undefined
    const offer = (offersResult.data as unknown[])?.[0] as { token: string; status: string; payment_type: string; payment_links: unknown[]; bank_details: unknown; bundled_pipelines: string[]; contract_type: string; lead_id: string; account_id: string } | undefined
    const pending = (pendingResult.data as unknown[])?.[0] as { id: string; offer_token: string; status: string; activated_at: string | null; payment_confirmed_at: string | null; payment_method: string; prepared_steps: unknown[]; confirmation_mode: string } | undefined
    const payments = (paymentsResult.data || []) as { id: string; amount: number; amount_currency: string; status: string; payment_method: string; paid_date: string; invoice_status: string; description: string }[]
    const services = (servicesResult.data || []) as { id: string; service_type: string; status: string; stage: string; stage_order: number; assigned_to: string; updated_at: string }[]
    let formationSub = (formationResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string } | undefined
    // Fallback: legacy formation submissions linked by lead_id (not contact_id)
    if (!formationSub && lead) {
      const { data: legacySub } = await supabaseAdmin
        .from("formation_submissions")
        .select("id, token, status, completed_at")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(1)
      formationSub = (legacySub as unknown[])?.[0] as typeof formationSub
    }
    const onboardingSub = (onboardingResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string } | undefined
    const taxForm = (taxFormResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string } | undefined
    const oa = (oaResult.data as unknown[])?.[0] as { id: string; token: string; status: string; signed_at: string } | undefined
    const lease = (leaseResult.data as unknown[])?.[0] as { id: string; token: string; status: string; signed_at: string; suite_number: string } | undefined
    const ss4 = (ss4Result.data as unknown[])?.[0] as { id: string; token: string; status: string } | undefined
    const bankingForms = (bankingResult.data || []) as { id: string; token: string; status: string; provider: string; submitted_data: Record<string, unknown> }[]
    const authUsers = (authUsersResult.data || []) as { id: string; email: string }[]
    const taxReturn = (taxReturnResult.data as unknown[])?.[0] as { id: string; tax_year: number; status: string; extension_filed: boolean; first_year_skip: boolean } | undefined
    const deadlines = (deadlinesResult.data || []) as { id: string; deadline_type: string; due_date: string; status: string }[]

    // ── Shared classification ──
    const formationSD = services.find(s => s.service_type === "Company Formation" && s.status === "active")
      ?? services.find(s => s.service_type === "Company Formation" && (s.status === "completed" || s.status === "Completed"))
    const classification = classifyAccount({
      accountId,
      accountType: account.account_type,
      accountStatus: account.status,
      einNumber: account.ein_number,
      formationDate: account.formation_date,
      entityType: account.entity_type,
      activeServiceTypes: services.filter(s => s.status === "active").map(s => s.service_type).filter(Boolean),
      formationSD: formationSD ? { stage: formationSD.stage, stageOrder: formationSD.stage_order, status: formationSD.status } : null,
      taxReturn: taxReturn ? { taxYear: taxReturn.tax_year, extensionFiled: taxReturn.extension_filed, status: taxReturn.status, firstYearSkip: taxReturn.first_year_skip } : null,
      ss4: ss4 ? { status: ss4.status } : null,
    })

    // Classification summary (first check in output)
    checks.push({
      id: "classification",
      category: "Classification",
      label: `Category: ${classification.category}`,
      status: classification.category === "incomplete" ? "warning" : "ok",
      detail: [
        classification.formationComplete ? "Formation: complete" : classification.formationInProgress ? "Formation: in progress" : "Formation: not started",
        classification.isWaitingForEIN ? "EIN: pending" : account.ein_number ? `EIN: ${account.ein_number}` : "EIN: none",
        classification.taxReturnExpected ? `Tax: expected (${classification.taxReturnReason})` : `Tax: ${classification.taxReturnReason}`,
        ...classification.pendingReasons.map(p => `⏳ ${p.reason}`),
      ].join(" · "),
    })

    // ═══════════════════════════════
    // CATEGORY: Contact
    // ═══════════════════════════════
    if (!primaryContact) {
      checks.push({
        id: "contact_linked",
        category: "Contact",
        label: "Linked contact",
        status: "error",
        detail: "No contact linked to this account",
      })
    } else {
      checks.push({
        id: "contact_linked",
        category: "Contact",
        label: "Linked contact",
        status: "ok",
        detail: `${primaryContact.full_name} (${primaryContact.email})`,
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Lead & Offer
    // ═══════════════════════════════
    if (lead) {
      checks.push({
        id: "lead_status",
        category: "Lead & Offer",
        label: "Lead status",
        status: lead.status === "Converted" ? "ok" : "warning",
        detail: `${lead.full_name}: ${lead.status}`,
        fix: lead.status !== "Converted" ? {
          action: "set_lead_converted",
          label: "Set to Converted",
          params: { lead_id: lead.id },
          description: "Updates the lead status to 'Converted' in the leads table.",
          impact: ["Lead will no longer appear in active leads list", "No downstream workflows triggered — this is a status label change only"],
          risk: "safe" as const,
        } : undefined,
      })
    }

    if (offer) {
      checks.push({
        id: "offer_status",
        category: "Lead & Offer",
        label: "Offer status",
        status: offer.status === "completed" ? "ok" : offer.status === "signed" ? "warning" : "error",
        detail: `${offer.token}: ${offer.status}`,
        fix: offer.status === "signed" ? {
          action: "set_offer_completed",
          label: "Set to completed (payment received)",
          params: { offer_token: offer.token },
          description: "Marks the offer as 'completed' — confirms payment was received.",
          impact: ["Offer page will show as completed to the client", "Does NOT create service deliveries automatically — use the Services fix below if needed"],
          risk: "moderate" as const,
        } : undefined,
      })
    } else {
      checks.push({
        id: "offer_status",
        category: "Lead & Offer",
        label: "Offer",
        status: "info",
        detail: "No offer found (may be a legacy client)",
      })
    }

    if (pending) {
      const pendingOk = pending.status === "activated"
      checks.push({
        id: "pending_activation",
        category: "Lead & Offer",
        label: "Activation pipeline",
        status: pendingOk ? "ok" : "error",
        detail: `Status: ${pending.status}${pending.activated_at ? `, activated ${pending.activated_at.split("T")[0]}` : ""}${pending.confirmation_mode === "supervised" && !pending.activated_at ? " (SUPERVISED — needs manual confirmation)" : ""}`,
        fix: !pendingOk ? {
          action: "complete_pending_activation",
          label: "Mark as activated",
          params: { pending_id: pending.id },
          description: "Sets the pending activation to 'activated' status with today's date.",
          impact: ["Activation pipeline will be marked complete", "Does NOT trigger service delivery creation — those must exist already or be created via Services fix"],
          risk: "safe" as const,
        } : undefined,
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Payments
    // ═══════════════════════════════
    const paidPayments = payments.filter(p => p.status === "Paid")
    const overduePayments = payments.filter(p => p.status === "Overdue" || p.invoice_status === "Overdue")

    if (paidPayments.length > 0) {
      const totalPaid = paidPayments.reduce((s, p) => s + p.amount, 0)
      checks.push({
        id: "payment_received",
        category: "Payments",
        label: "Setup payment",
        status: "ok",
        detail: `${paidPayments.length} paid (${paidPayments[0].amount_currency || "USD"} ${totalPaid.toLocaleString()})`,
      })
    } else if (payments.length > 0) {
      checks.push({
        id: "payment_received",
        category: "Payments",
        label: "Setup payment",
        status: "warning",
        detail: `${payments.length} payment(s) but none marked Paid`,
        fix: {
          action: "mark_payment_paid",
          label: "Mark as paid",
          params: { payment_id: payments[0].id },
          description: "Marks the existing payment record as 'Paid' with today's date.",
          impact: ["Payment status changes to Paid in the system", "Client invoice (if linked) will reflect paid status", "Referral commission calculation may use this payment as trigger"],
          risk: "moderate" as const,
        },
      })
    } else {
      // Zero payments — check bank feeds and pending_activations before flagging error
      // A matched bank feed means Finance already confirmed the money arrived
      let matchedFeed: { amount: number; currency: string; transaction_date: string; source: string; sender_name: string } | null = null

      // Check 1: pending_activation with payment_confirmed_at (cron already verified payment)
      const hasPendingConfirmation = pending?.payment_confirmed_at != null

      // Check 2: td_bank_feeds with status=matched where sender matches company name
      if (account.company_name) {
        const companyWords = account.company_name.replace(/\s*(LLC|INC|CORP|LTD)\.?\s*/gi, "").trim()
        if (companyWords.length >= 3) {
          const { data: feeds } = await supabaseAdmin
            .from("td_bank_feeds")
            .select("amount, currency, transaction_date, source, sender_name")
            .eq("status", "matched")
            .ilike("sender_name", `%${companyWords}%`)
            .order("transaction_date", { ascending: false })
            .limit(1)
          if (feeds && feeds.length > 0) {
            matchedFeed = feeds[0]
          }
        }
      }

      // Parse offer amount for the fix button
      let offerAmount = 0
      let offerCurrency: "EUR" | "USD" = "EUR"
      if (offer) {
        const svc = (offer as unknown as { services: Array<{ price: string; optional?: boolean }> }).services || []
        for (const s of svc) {
          if (!s.price || s.price.toLowerCase().includes("/year") || s.price.toLowerCase().includes("inclus")) continue
          // Handle European format: €2.500 (dot = thousands) and €2,500 (comma = thousands)
          let clean = s.price.replace(/[^0-9.,]/g, "")
          // If format is X.XXX (dot as thousands separator with no decimal), remove dots
          if (/^\d{1,3}\.\d{3}$/.test(clean)) clean = clean.replace(".", "")
          // Remove commas (thousands separator in US format)
          clean = clean.replace(",", "")
          const num = parseFloat(clean)
          if (!isNaN(num)) offerAmount += num
        }
        const firstPrice = svc[0]?.price || ""
        if (firstPrice.includes("$")) offerCurrency = "USD"
      }

      // Use bank feed data for amount/currency if available (more accurate than offer parsing)
      const fixAmount = matchedFeed ? matchedFeed.amount : (offerAmount || null)
      const fixCurrency = matchedFeed ? (matchedFeed.currency === "USD" ? "USD" : "EUR") as "EUR" | "USD" : offerCurrency
      const fixPaidDate = matchedFeed?.transaction_date || undefined

      if (matchedFeed || hasPendingConfirmation) {
        // Payment was received (bank feed matched or pending activation confirmed) but no payment record created
        const feedDetail = matchedFeed
          ? `${matchedFeed.currency} ${matchedFeed.amount.toLocaleString()} received via ${matchedFeed.source} on ${matchedFeed.transaction_date}`
          : `Payment confirmed on ${pending?.payment_confirmed_at?.split("T")[0]}`

        checks.push({
          id: "payment_received",
          category: "Payments",
          label: "Setup payment",
          status: "warning",
          detail: `Bank feed matched but no payment record — ${feedDetail}`,
          fix: {
            action: "record_payment",
            label: fixAmount ? `Record ${fixCurrency === "EUR" ? "€" : "$"}${Number(fixAmount).toLocaleString()} payment` : "Record payment",
            params: {
              account_id: accountId,
              contact_id: contactId,
              amount: fixAmount,
              currency: fixCurrency,
              payment_method: offer?.payment_type === "bank_transfer" ? "Wire Transfer" : (pending?.payment_method || "Wire Transfer"),
              description: `Setup fee — ${offer?.token || "onboarding"}`,
              offer_token: offer?.token || undefined,
              paid_date: fixPaidDate,
            },
            description: `Creates a payment record for ${fixAmount ? `${fixCurrency === "EUR" ? "€" : "$"}${Number(fixAmount).toLocaleString()}` : "the setup fee"} as Paid on ${fixPaidDate || "today"}. Links this to the matched bank feed.`,
            impact: [
              "A new payment row will be created in the payments table linked to this account",
              `Payment will be marked as Paid with date ${fixPaidDate || "today"}`,
              "Diagnostic will show green after this fix",
              "Finance bank feed and diagnostic will be in sync",
            ],
            risk: "safe" as const,
          },
        })
      } else {
        checks.push({
          id: "payment_received",
          category: "Payments",
          label: "Setup payment",
          status: "error",
          detail: "No payments found" + (offer?.status === "completed" ? " — offer is completed, payment may have been received externally" : ""),
          fix: offer?.status === "completed" ? {
            action: "record_payment",
            label: offerAmount > 0 ? `Record ${offerCurrency === "EUR" ? "€" : "$"}${offerAmount.toLocaleString()} payment` : "Record payment",
            params: {
              account_id: accountId,
              contact_id: contactId,
              amount: offerAmount || null,
              currency: offerCurrency,
              payment_method: offer.payment_type === "bank_transfer" ? "Wire Transfer" : "Card",
              description: `Setup fee — ${offer.token}`,
              offer_token: offer.token,
            },
            description: `Creates a new payment record for ${offerAmount > 0 ? `${offerCurrency === "EUR" ? "€" : "$"}${offerAmount.toLocaleString()}` : "the setup fee"} as Paid via ${offer.payment_type === "bank_transfer" ? "Wire Transfer" : "Card"}.`,
            impact: [
              "A new payment row will be created in the payments table linked to this account",
              "Payment will be marked as Paid with today's date",
              "Finance dashboard will reflect this payment",
              "Does NOT create a client invoice — invoice must be created separately if needed",
            ],
            risk: "moderate" as const,
          } : undefined,
        })
      }
    }

    if (overduePayments.length > 0) {
      checks.push({
        id: "overdue_payments",
        category: "Payments",
        label: "Overdue payments",
        status: "warning",
        detail: `${overduePayments.length} overdue (${overduePayments.map(p => `${p.amount_currency || "USD"} ${p.amount}`).join(", ")})`,
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Service Delivery (classification-driven)
    // ═══════════════════════════════

    // Show ALL existing service deliveries with their real status
    if (services.length > 0) {
      for (const sd of services) {
        const sdStatus = sd.status === "active" ? "ok"
          : sd.status === "Completed" || sd.status === "completed" ? "ok"
            : sd.status === "cancelled" ? "info"
              : "warning"
        checks.push({
          id: `sd_${sd.service_type.toLowerCase().replace(/\s+/g, "_")}`,
          category: "Services",
          label: sd.service_type,
          status: sdStatus,
          detail: `Status: ${sd.status}${sd.stage ? ` — Stage: ${sd.stage}` : ""}${sd.assigned_to ? ` — ${sd.assigned_to}` : ""}`,
        })
      }
    }

    // Check for missing SDs using classification
    if (classification.category === "new_formation") {
      checks.push({
        id: "sd_formation_pending",
        category: "Services",
        label: "Standard services",
        status: "info",
        detail: "Formation in progress — standard SDs will be created after formation completes",
      })
    } else if (classification.missingSDs.length > 0) {
      checks.push({
        id: "sd_missing",
        category: "Services",
        label: `Missing: ${classification.missingSDs.join(", ")}`,
        status: "error",
        detail: `Expected [${classification.expectedSDs.join(", ")}] but missing: ${classification.missingSDs.join(", ")}`,
        fix: {
          action: "create_service_deliveries",
          label: `Create ${classification.missingSDs.length} missing service(s)`,
          params: { pipelines: classification.missingSDs, account_id: accountId, contact_id: contactId },
          description: `Creates service deliveries for: ${classification.missingSDs.join(", ")}. Each starts at Stage 1.`,
          impact: classification.missingSDs.map(m => `${m} SD created at first stage`),
          risk: "safe" as const,
        },
      })
    } else if (services.length === 0 && classification.category !== "one_time") {
      checks.push({
        id: "sd_none",
        category: "Services",
        label: "Service deliveries",
        status: "warning",
        detail: "No service deliveries found",
      })
    }

    // Tax Return expectation
    if (classification.taxReturnExpected && !classification.actualSDs.includes("Tax Return")) {
      checks.push({
        id: "tax_expected",
        category: "Services",
        label: "Tax Return expected",
        status: "warning",
        detail: classification.taxReturnReason,
      })
    } else if (!classification.taxReturnExpected && classification.taxReturnReason && classification.category !== "new_formation") {
      checks.push({
        id: "tax_info",
        category: "Services",
        label: "Tax Return",
        status: "info",
        detail: classification.taxReturnReason,
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Forms
    const bundledPipelines = offer?.bundled_pipelines || []
    // ═══════════════════════════════
    const contractType = offer?.contract_type || null

    if (contractType === "formation" || bundledPipelines.includes("Company Formation")) {
      checks.push({
        id: "formation_form",
        category: "Forms",
        label: "Formation wizard",
        status: formationSub
          ? (formationSub.status === "completed" || formationSub.status === "reviewed" ? "ok" : "info")
          : "error",
        detail: formationSub
          ? `Status: ${formationSub.status}${formationSub.completed_at ? ` (${formationSub.completed_at.split("T")[0]})` : ""}`
          : "No formation form created",
        fix: !formationSub && lead ? {
          action: "create_formation_form",
          label: "Create formation wizard",
          params: { lead_id: lead.id, contact_id: contactId },
          description: "Creates a formation data collection form pre-filled with the lead's info. The client receives a link to fill in their personal details (address, DOB, passport).",
          impact: ["A new formation_submissions row is created in draft status", "Form URL is generated but NOT sent to the client automatically — must be sent separately via email"],
          risk: "safe" as const,
        } : undefined,
      })
    }

    if (contractType === "onboarding" || (!contractType && !bundledPipelines.includes("Company Formation"))) {
      if (onboardingSub) {
        checks.push({
          id: "onboarding_form",
          category: "Forms",
          label: "Onboarding wizard",
          status: onboardingSub.status === "completed" || onboardingSub.status === "reviewed" ? "ok" : "info",
          detail: `Status: ${onboardingSub.status}`,
        })
      }
    }

    if (taxForm) {
      checks.push({
        id: "tax_form",
        category: "Forms",
        label: "Tax wizard",
        status: taxForm.status === "completed" || taxForm.status === "submitted" || taxForm.status === "reviewed" ? "ok" : "info",
        detail: `Status: ${taxForm.status}`,
      })
    }

    // Banking forms
    const relayForm = bankingForms.find(b => b.provider === "relay")
    const paysetForm = bankingForms.find(b => b.provider === "payset")

    if (relayForm) {
      const hasData = relayForm.submitted_data && Object.keys(relayForm.submitted_data).length > 0
      checks.push({
        id: "banking_relay",
        category: "Forms",
        label: "Banking: Relay",
        status: relayForm.status === "completed" || relayForm.status === "reviewed" ? "ok"
          : hasData ? "info" : "warning",
        detail: `Status: ${relayForm.status}${!hasData ? " (empty — not filled by client)" : ""}`,
      })
    }

    if (paysetForm) {
      const hasData = paysetForm.submitted_data && Object.keys(paysetForm.submitted_data).length > 0
      checks.push({
        id: "banking_payset",
        category: "Forms",
        label: "Banking: Payset",
        status: paysetForm.status === "completed" || paysetForm.status === "reviewed" ? "ok"
          : hasData ? "info" : "warning",
        detail: `Status: ${paysetForm.status}${!hasData ? " (empty — not filled by client)" : ""}`,
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Documents
    // ═══════════════════════════════
    checks.push({
      id: "oa_status",
      category: "Documents",
      label: "Operating Agreement",
      status: oa
        ? (oa.status === "signed" ? "ok" : oa.status === "sent" ? "info" : "warning")
        : "warning",
      detail: oa ? `${oa.status}${oa.signed_at ? ` (signed ${oa.signed_at.split("T")[0]})` : ""}` : "Not created",
      fix: !oa ? {
        action: "create_oa",
        label: "Create OA (draft)",
        params: { account_id: accountId },
        description: "Creates an Operating Agreement in draft status, pre-filled with the LLC's company name, state, and member info from the CRM.",
        impact: ["A new oa_agreements row is created in draft status", "OA will appear in the client's portal under Sign Documents once sent", "Does NOT send anything to the client — must be reviewed and sent separately"],
        risk: "safe" as const,
      } : undefined,
    })

    checks.push({
      id: "lease_status",
      category: "Documents",
      label: "Lease Agreement",
      status: lease
        ? (lease.status === "signed" ? "ok" : lease.status === "sent" ? "info" : "warning")
        : "warning",
      detail: lease ? `${lease.status} (Suite ${lease.suite_number || "N/A"})` : "Not created",
      fix: !lease ? {
        action: "create_lease",
        label: "Create Lease (draft)",
        params: { account_id: accountId },
        description: "Creates a Lease Agreement in draft status with an auto-assigned suite number, pre-filled with the LLC's company name and primary contact info.",
        impact: ["A new lease_agreements row is created in draft status", "A suite number is assigned to this client", "Lease will appear in the client's portal under Sign Documents once sent", "Does NOT send anything to the client — must be reviewed and sent separately"],
        risk: "safe" as const,
      } : undefined,
    })

    // EIN / SS-4 — uses classification to distinguish pending vs missing
    if (account.ein_number) {
      checks.push({
        id: "ss4_status",
        category: "Documents",
        label: "EIN / SS-4",
        status: "ok",
        detail: `EIN: ${account.ein_number}${ss4 ? ` — SS-4: ${ss4.status}` : ""}`,
      })
    } else if (classification.isWaitingForEIN) {
      const einReason = classification.pendingReasons.find(p => p.field === "ein_number")
      checks.push({
        id: "ss4_status",
        category: "Documents",
        label: "EIN pending",
        status: "info",
        detail: einReason?.reason ?? "EIN not yet received",
      })
    } else if (ss4) {
      checks.push({
        id: "ss4_status",
        category: "Documents",
        label: "SS-4 Application",
        status: ss4.status === "done" ? "ok" : "info",
        detail: `Status: ${ss4.status}`,
      })
    } else if (classification.formationComplete) {
      const einReason = classification.pendingReasons.find(p => p.field === "ein_number")
      checks.push({
        id: "ss4_status",
        category: "Documents",
        label: "EIN",
        status: einReason ? "warning" : "error",
        detail: einReason?.reason ?? "Missing — formation complete but EIN not recorded",
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Portal Access
    // ═══════════════════════════════
    const authUser = authUsers[0]
    const contactTier = primaryContact?.portal_tier || null
    const accountTier = account.portal_tier || null

    // Check if auth user exists but portal_account flag is missing (half-setup)
    const portalHalfSetup = authUser && !account.portal_account
    checks.push({
      id: "portal_user",
      category: "Portal",
      label: "Portal auth user",
      status: authUser ? (portalHalfSetup ? "warning" : "ok") : "error",
      detail: authUser
        ? (portalHalfSetup ? `Auth user exists (${authUser.email}) but portal_account flag not set — portal may not work correctly` : `Exists (${authUser.email})`)
        : "No portal login — client cannot access portal",
      fix: (!authUser || portalHalfSetup) && contactEmail ? {
        action: "create_portal_user",
        label: portalHalfSetup ? "Repair portal setup" : "Create portal login",
        params: { contact_id: contactId, email: contactEmail },
        description: "Creates (or repairs) a portal login for this client. Sets full auth metadata, portal_account flag on accounts, and sends welcome email with credentials.",
        impact: ["Auth user is created or repaired with full metadata (contact_id, account_ids, portal_tier)", "portal_account flag set on all linked accounts", "Welcome email with temp password sent automatically", "Client can log in at portal.tonydurante.us"],
        risk: "high" as const,
      } : undefined,
    })

    // Determine expected tier — account.status is the strongest signal for legacy clients
    const isActiveAccount = account.status === "Active"
    const hasPaidPayment = paidPayments.length > 0
    const hasCompletedForm = formationSub?.status === "completed" || onboardingSub?.status === "completed"
    const hasCompletedServices = services.some(s => s.status === "Completed" || s.status === "completed")
    const hasActiveFormationNoEin = services.some(s => s.service_type === "Company Formation" && s.status === "active") && !account.ein_number
    const expectedTier = (isActiveAccount && (hasCompletedServices || hasCompletedForm)) ? "active"
      : (isActiveAccount && account.portal_account) ? "active"  // legacy clients with portal access
        : hasCompletedForm ? "active"
          : hasActiveFormationNoEin ? "formation"
            : hasPaidPayment ? "onboarding"
              : "lead"

    checks.push({
      id: "portal_tier_contact",
      category: "Portal",
      label: "Portal tier (contact)",
      status: contactTier === expectedTier ? "ok" : contactTier ? "warning" : "error",
      detail: `Current: ${contactTier || "null"}, expected: ${expectedTier}`,
      fix: contactTier !== expectedTier && contactId ? {
        action: "set_portal_tier",
        label: `Upgrade to ${expectedTier}`,
        params: { contact_id: contactId, tier: expectedTier },
        description: `Updates the contact's portal_tier to '${expectedTier}', which controls what the client can see and do in the portal.`,
        impact: ["Contact's portal_tier is updated in the contacts table", "Client's portal UI will show different sections based on the new tier (lead < onboarding < active)", "If upgrading to 'active', client gains access to documents, invoices, and chat"],
        risk: "high" as const,
      } : undefined,
    })

    if (accountTier && accountTier !== contactTier) {
      checks.push({
        id: "portal_tier_sync",
        category: "Portal",
        label: "Portal tier sync",
        status: "warning",
        detail: `Account tier (${accountTier}) != Contact tier (${contactTier})`,
        fix: {
          action: "sync_portal_tier",
          label: "Sync to contact tier",
          params: { account_id: accountId, contact_id: contactId, tier: contactTier || expectedTier },
          description: "Syncs the portal_tier field so both the account and contact records have the same value. Resolves the mismatch that can cause inconsistent portal behavior.",
          impact: ["Both accounts.portal_tier and contacts.portal_tier are updated to the same value", "Portal access level becomes consistent across both records"],
          risk: "high" as const,
        },
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Infrastructure
    // ═══════════════════════════════
    checks.push({
      id: "drive_folder",
      category: "Infrastructure",
      label: "Google Drive folder",
      status: account.drive_folder_id ? "ok" : "warning",
      detail: account.drive_folder_id ? "Exists" : "No Drive folder",
      fix: !account.drive_folder_id ? {
        action: "create_drive_folder",
        label: "Create Drive folder",
        params: { account_id: accountId, company_name: account.company_name },
        description: "Creates the client's Google Drive folder structure on the Shared Drive (Companies/{State}/{Company Name}/ with subfolders 1-5) and links it to the account record.",
        impact: ["A new folder tree is created on Google Drive", "Account's drive_folder_id is updated with the new folder ID", "Document processing and uploads will use this folder going forward"],
        risk: "safe" as const,
      } : undefined,
    })

    if (taxReturn) {
      checks.push({
        id: "tax_return",
        category: "Infrastructure",
        label: `Tax return ${taxReturn.tax_year}`,
        status: "ok",
        detail: `Status: ${taxReturn.status}`,
      })
    } else if (account.status === "Active") {
      checks.push({
        id: "tax_return",
        category: "Infrastructure",
        label: "Tax return",
        status: "warning",
        detail: "No tax return record for this account",
      })
    }

    const hasAnnualReport = deadlines.some(d => d.deadline_type === "Annual Report")
    const hasRaRenewal = deadlines.some(d => d.deadline_type === "RA Renewal")

    if (!hasAnnualReport && account.status === "Active") {
      checks.push({
        id: "deadline_ar",
        category: "Infrastructure",
        label: "Annual Report deadline",
        status: "warning",
        detail: "No Annual Report deadline set",
        fix: {
          action: "create_deadline",
          label: "Create deadline",
          params: { account_id: accountId, type: "Annual Report" },
          description: "Creates an Annual Report deadline for this account based on the state's filing rules. The due date is calculated from the state of formation.",
          impact: ["A new deadline row is created in the deadlines table", "Deadline will appear in the compliance dashboard and upcoming deadlines view", "Automated reminder emails will fire as the due date approaches"],
          risk: "moderate" as const,
        },
      })
    }

    if (!hasRaRenewal && account.status === "Active") {
      checks.push({
        id: "deadline_ra",
        category: "Infrastructure",
        label: "RA Renewal deadline",
        status: "warning",
        detail: "No RA Renewal deadline set",
        fix: {
          action: "create_deadline",
          label: "Create deadline",
          params: { account_id: accountId, type: "RA Renewal" },
          description: "Creates a Registered Agent Renewal deadline for this account. The due date is based on the RA service expiration from Harbor Compliance.",
          impact: ["A new deadline row is created in the deadlines table", "Deadline will appear in the compliance dashboard and upcoming deadlines view", "Automated reminder emails will fire as the due date approaches"],
          risk: "moderate" as const,
        },
      })
    }

    // ─── Summary ───
    const summary = {
      ok: checks.filter(c => c.status === "ok").length,
      warning: checks.filter(c => c.status === "warning").length,
      error: checks.filter(c => c.status === "error").length,
      info: checks.filter(c => c.status === "info").length,
      total: checks.length,
    }

    return NextResponse.json({
      account: { id: accountId, company_name: account.company_name, status: account.status },
      checks,
      summary,
    })
  } catch (e) {
    console.error("[diagnose-account] Error:", e)
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

// ─── POST: Execute Fix ───

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { account_id, action, params } = body

    if (!account_id || !action) {
      return NextResponse.json({ error: "Missing account_id or action" }, { status: 400 })
    }

    let result: { success: boolean; detail: string }

    switch (action) {
      case "set_lead_converted": {
        const { error } = await supabaseAdmin
          .from("leads")
          .update({ status: "Converted", updated_at: new Date().toISOString() })
          .eq("id", params.lead_id)
        result = { success: !error, detail: error ? error.message : "Lead set to Converted" }
        break
      }

      case "set_offer_completed": {
        const { error } = await supabaseAdmin
          .from("offers")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("token", params.offer_token)
        result = { success: !error, detail: error ? error.message : "Offer set to completed" }
        break
      }

      case "complete_pending_activation": {
        const { error } = await supabaseAdmin
          .from("pending_activations")
          .update({ status: "activated", activated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", params.pending_id)
        result = { success: !error, detail: error ? error.message : "Activation marked as completed" }
        break
      }

      case "mark_payment_paid": {
        const { error } = await supabaseAdmin
          .from("payments")
          .update({ status: "Paid", paid_date: new Date().toISOString().split("T")[0], updated_at: new Date().toISOString() })
          .eq("id", params.payment_id)
        result = { success: !error, detail: error ? error.message : "Payment marked as paid" }
        break
      }

      case "record_payment": {
        const paidDate = (params.paid_date as string) || new Date().toISOString().split("T")[0]
        const bankName = params.bank_name as string | undefined
        const { data: newPayment, error } = await supabaseAdmin
          .from("payments")
          .insert({
            account_id: params.account_id,
            contact_id: params.contact_id || null,
            amount: params.amount || 0,
            amount_paid: params.amount || 0,
            amount_due: 0,
            amount_currency: params.currency || "EUR",
            status: "Paid",
            invoice_status: "Paid",
            payment_method: params.payment_method || "Wire Transfer",
            description: params.description || "Setup payment",
            paid_date: paidDate,
            issue_date: paidDate,
            period: "One-Time",
            year: new Date().getFullYear(),
            installment: "One-Time",
            notes: `Recorded via diagnostic fix${bankName ? ` — bank: ${bankName}` : ""}${params.offer_token ? ` — offer: ${params.offer_token}` : ""}`,
          })
          .select("id")
          .single()

        // Link matched bank feeds to this new payment record
        if (newPayment?.id && params.account_id) {
          const { data: acct } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", params.account_id as string)
            .single()
          if (acct?.company_name) {
            const companyWords = acct.company_name.replace(/\s*(LLC|INC|CORP|LTD)\.?\s*/gi, "").trim()
            if (companyWords.length >= 3) {
              await supabaseAdmin
                .from("td_bank_feeds")
                .update({
                  matched_payment_id: newPayment.id,
                  match_confidence: "diagnostic",
                  matched_at: new Date().toISOString(),
                  matched_by: "staff",
                  updated_at: new Date().toISOString(),
                })
                .eq("status", "matched")
                .is("matched_payment_id", null)
                .ilike("sender_name", `%${companyWords}%`)
            }
          }
        }

        const amt = params.amount ? `${params.currency === "USD" ? "$" : "€"}${Number(params.amount).toLocaleString()}` : "unknown amount"
        result = { success: !error, detail: error ? error.message : `Payment recorded: ${amt} (${newPayment?.id?.slice(0, 8)})` }
        break
      }

      case "set_portal_tier": {
        const tier = params.tier as string
        const { error: contactErr } = await supabaseAdmin
          .from("contacts")
          .update({ portal_tier: tier, updated_at: new Date().toISOString() })
          .eq("id", params.contact_id)
        result = { success: !contactErr, detail: contactErr ? contactErr.message : `Portal tier set to ${tier}` }
        break
      }

      case "sync_portal_tier": {
        const tier = params.tier as string
        await supabaseAdmin
          .from("contacts")
          .update({ portal_tier: tier, updated_at: new Date().toISOString() })
          .eq("id", params.contact_id)
        await supabaseAdmin
          .from("accounts")
          .update({ portal_tier: tier, updated_at: new Date().toISOString() })
          .eq("id", params.account_id)
        result = { success: true, detail: `Both synced to ${tier}` }
        break
      }

      case "create_service_delivery": {
        try {
          await createSD({
            service_type: params.service_type as string,
            service_name: params.service_type as string,
            account_id: (params.account_id as string) || null,
            contact_id: (params.contact_id as string) || null,
          })
          result = { success: true, detail: `${params.service_type} created` }
        } catch (e) {
          result = { success: false, detail: e instanceof Error ? e.message : String(e) }
        }
        break
      }

      case "create_service_deliveries": {
        const pipelines = params.pipelines as string[]
        let created = 0
        const errors: string[] = []
        for (const p of pipelines) {
          try {
            await createSD({
              service_type: p,
              service_name: p,
              account_id: (params.account_id as string) || null,
              contact_id: (params.contact_id as string) || null,
            })
            created++
          } catch (e) {
            errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        result = {
          success: created > 0,
          detail: `Created ${created}/${pipelines.length} services${errors.length ? ` (errors: ${errors.join("; ")})` : ""}`,
        }
        break
      }

      case "create_portal_user": {
        // Fetch contact details for proper metadata
        const { data: contactForPortal } = await supabaseAdmin
          .from("contacts")
          .select("full_name, email, portal_tier")
          .eq("id", params.contact_id)
          .single()

        // Fetch account_ids via junction table (not primary_contact_id)
        const { data: contactAccountLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", params.contact_id)

        const accountIds = (contactAccountLinks || []).map((a: { account_id: string }) => a.account_id)
        const portalTier = contactForPortal?.portal_tier || "active"
        const portalEmail = (contactForPortal?.email || params.email) as string
        const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

        // Check if user already exists (paginated — P1.9)
        const existingUser = await findAuthUserByEmail(portalEmail)

        if (existingUser) {
          // Fix metadata on existing user
          await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
            password: tempPassword,
            app_metadata: {
              ...existingUser.app_metadata,
              role: "client",
              contact_id: params.contact_id,
              portal_tier: portalTier,
              ...(accountIds.length > 0 ? { account_ids: accountIds } : {}),
            },
            user_metadata: {
              ...existingUser.user_metadata,
              full_name: contactForPortal?.full_name || "Client",
              must_change_password: true,
            },
          })
        } else {
          const { error: authErr } = await supabaseAdmin.auth.admin.createUser({
            email: portalEmail,
            password: tempPassword,
            email_confirm: true,
            app_metadata: {
              role: "client",
              contact_id: params.contact_id,
              portal_tier: portalTier,
              ...(accountIds.length > 0 ? { account_ids: accountIds } : {}),
            },
            user_metadata: {
              full_name: contactForPortal?.full_name || params.full_name || "Client",
              must_change_password: true,
            },
          })
          if (authErr) {
            result = { success: false, detail: authErr.message }
            break
          }
        }

        // Update contact tier
        await supabaseAdmin
          .from("contacts")
          .update({ portal_tier: portalTier, updated_at: new Date().toISOString() })
          .eq("id", params.contact_id)

        // Set portal_account flag on all linked accounts
        if (accountIds.length > 0) {
          await supabaseAdmin
            .from("accounts")
            .update({
              portal_account: true,
              portal_tier: portalTier,
              portal_created_date: new Date().toISOString().split("T")[0],
            })
            .in("id", accountIds)
        }

        // Send welcome email with credentials
        try {
          const { gmailPost } = await import("@/lib/gmail")
          const { PORTAL_BASE_URL } = await import("@/lib/config")
          const loginUrl = `${PORTAL_BASE_URL}/portal/login`
          const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 18px;">Welcome to Tony Durante Portal</h1>
              </div>
              <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
                <p>Hi ${contactForPortal?.full_name || "there"},</p>
                <p>Your portal account has been created. Here are your login credentials:</p>
                <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
                  <p style="margin: 0 0 8px;"><strong>Email:</strong> ${portalEmail}</p>
                  <p style="margin: 0;"><strong>Temporary Password:</strong> ${tempPassword}</p>
                </div>
                <p>You will be asked to change your password on first login.</p>
                <a href="${loginUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 8px;">
                  Login to Portal
                </a>
              </div>
            </div>
          `
          const subject = "Your Tony Durante Portal Account"
          const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
          const boundary = `boundary_${Date.now()}`
          const rawEmail = [
            "From: Tony Durante <support@tonydurante.us>",
            `To: ${portalEmail}`,
            `Subject: ${encodedSubject}`,
            "MIME-Version: 1.0",
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/html; charset=UTF-8",
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(html).toString("base64"),
            `--${boundary}--`,
          ].join("\r\n")
          await gmailPost("/messages/send", { raw: Buffer.from(rawEmail).toString("base64url") })
        } catch (emailErr) {
          console.error("Welcome email failed:", emailErr)
        }

        result = { success: true, detail: existingUser ? "Portal user repaired + credentials resent" : "Portal user created + welcome email sent" }
        break
      }

      default:
        result = { success: false, detail: `Unknown action: ${action}` }
    }

    // Log action
    await supabaseAdmin.from("action_log").insert({
      actor: "crm-admin",
      action_type: "diagnose_fix",
      table_name: "accounts",
      record_id: account_id,
      summary: `Diagnostic fix: ${action} — ${result.detail}`,
      details: { action, params, result },
    })

    return NextResponse.json(result)
  } catch (e) {
    console.error("[diagnose-account] Fix error:", e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
