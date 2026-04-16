/**
 * Contact Diagnostic API
 *
 * GET  ?contact_id=UUID — Run full audit on a contact
 * POST { contact_id, action, params } — Execute a one-click fix
 *
 * Contact-centric: checks 8 categories (Profile, Lead & Offer, Payments, Services,
 * Wizard & Forms, Portal Access, Linked Accounts, Documents).
 * Each check returns ok/warning/error/info with optional fix action.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
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
    description: string
    impact: string[]
    risk: "safe" | "moderate" | "high"
  }
}

// ─── GET: Run Diagnostic ───

export async function GET(req: NextRequest) {
  const contactId = req.nextUrl.searchParams.get("contact_id")
  if (!contactId) {
    return NextResponse.json({ error: "Missing contact_id" }, { status: 400 })
  }

  try {
    const checks: DiagnosticCheck[] = []

    // Load contact
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .single()

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    const contactEmail = contact.email as string | null

    // Load linked accounts
    const { data: accountContacts } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id, role, accounts(id, company_name, status, entity_type, state_of_formation, ein_number, drive_folder_id, portal_tier)")
      .eq("contact_id", contactId)

    const linkedAccounts = (accountContacts ?? []).map(ac => {
      const a = ac.accounts as unknown as {
        id: string; company_name: string; status: string | null; entity_type: string | null
        state_of_formation: string | null; ein_number: string | null; drive_folder_id: string | null
        portal_tier: string | null
      }
      return { ...a, role: ac.role }
    })
    const accountIds = linkedAccounts.map(a => a.id)

    // Load all related data in parallel
    const [
      leadsResult,
      offersResult,
      pendingResult,
      paymentsResult,
      servicesResult,
      wizardResult,
      formationResult,
      onboardingResult,
      docsResult,
      oaResult,
      leaseResult,
    ] = await Promise.all([
      // Lead
      contactEmail
        ? supabaseAdmin.from("leads").select("id, full_name, status, email").ilike("email", contactEmail).limit(1)
        : { data: [] },
      // Offers
      contactEmail
        ? supabaseAdmin.from("offers").select("id, token, status, contract_type, services, bundled_pipelines, client_email")
            .eq("client_email", contactEmail).order("created_at", { ascending: false }).limit(1)
        : { data: [] },
      // Pending activations
      contactEmail
        ? supabaseAdmin.from("pending_activations").select("id, status, signed_at, payment_confirmed_at, activated_at, payment_method, amount, currency")
            .eq("client_email", contactEmail).order("created_at", { ascending: false }).limit(1)
        : { data: [] },
      // Payments (contact-direct + account-linked)
      supabaseAdmin.from("payments").select("id, amount, amount_currency, status, payment_method, paid_date, invoice_status, description, account_id, contact_id")
        .or(`contact_id.eq.${contactId}${accountIds.length > 0 ? `,account_id.in.(${accountIds.join(",")})` : ""}`)
        .order("created_at", { ascending: false }),
      // Service deliveries (contact-direct + account-linked)
      supabaseAdmin.from("service_deliveries").select("id, service_name, service_type, pipeline, stage, status, assigned_to, account_id, contact_id, updated_at")
        .or(`contact_id.eq.${contactId}${accountIds.length > 0 ? `,account_id.in.(${accountIds.join(",")})` : ""}`)
        .order("updated_at", { ascending: false }),
      // Wizard progress
      supabaseAdmin.from("wizard_progress").select("id, wizard_type, current_step, status, created_at, updated_at")
        .eq("contact_id", contactId),
      // Formation submission
      supabaseAdmin.from("formation_submissions").select("id, token, status, completed_at")
        .eq("contact_id", contactId).limit(1),
      // Onboarding submission
      supabaseAdmin.from("onboarding_submissions").select("id, token, status, completed_at")
        .eq("contact_id", contactId).limit(1),
      // Documents
      supabaseAdmin.from("documents").select("id, file_name, document_type_name, category_name, drive_file_id")
        .eq("contact_id", contactId),
      // OA (via linked accounts)
      accountIds.length > 0
        ? supabaseAdmin.from("oa_agreements").select("id, status, signed_at, account_id")
            .in("account_id", accountIds).order("created_at", { ascending: false })
        : { data: [] },
      // Lease (via linked accounts)
      accountIds.length > 0
        ? supabaseAdmin.from("lease_agreements").select("id, status, signed_at, account_id")
            .in("account_id", accountIds).order("created_at", { ascending: false })
        : { data: [] },
    ])

    // Auth user check
    let authUser: { id: string; email: string; last_sign_in_at: string | null } | null = null
    if (contactEmail) {
      try {
        const found = await findAuthUserByEmail(contactEmail)
        if (found) {
          authUser = { id: found.id, email: found.email ?? contactEmail, last_sign_in_at: found.last_sign_in_at ?? null }
        }
      } catch {
        // Non-critical
      }
    }

    const lead = (leadsResult.data as unknown[])?.[0] as { id: string; full_name: string; status: string; email: string } | undefined
    const offer = (offersResult.data as unknown[])?.[0] as { id: string; token: string; status: string; contract_type: string; services: Array<{ name?: string; price?: string; optional?: boolean }>; bundled_pipelines: string[] } | undefined
    const pending = (pendingResult.data as unknown[])?.[0] as { id: string; status: string; signed_at: string | null; payment_confirmed_at: string | null; activated_at: string | null; payment_method: string | null; amount: number | null; currency: string | null } | undefined
    const payments = (paymentsResult.data ?? []) as { id: string; amount: number; amount_currency: string; status: string; payment_method: string; paid_date: string; invoice_status: string; description: string; account_id: string | null; contact_id: string | null }[]
    const services = (servicesResult.data ?? []) as { id: string; service_name: string; service_type: string; pipeline: string | null; stage: string | null; status: string; assigned_to: string | null; account_id: string | null; contact_id: string | null; updated_at: string }[]
    const wizards = (wizardResult.data ?? []) as { id: string; wizard_type: string; current_step: number; status: string; created_at: string; updated_at: string }[]
    const formationSub = (formationResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string | null } | undefined
    const onboardingSub = (onboardingResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string | null } | undefined
    const docs = (docsResult.data ?? []) as { id: string; file_name: string; document_type_name: string | null; category_name: string | null; drive_file_id: string | null }[]
    const oaAgreements = (oaResult.data ?? []) as { id: string; status: string; signed_at: string | null; account_id: string }[]
    const leaseAgreements = (leaseResult.data ?? []) as { id: string; status: string; signed_at: string | null; account_id: string }[]

    // ═══════════════════════════════
    // CATEGORY A: Contact Profile
    // ═══════════════════════════════
    checks.push({
      id: "profile_dob",
      category: "Contact Profile",
      label: "Date of birth",
      status: contact.date_of_birth ? "ok" : "warning",
      detail: contact.date_of_birth ? contact.date_of_birth : "Missing — needed for wizard/SS-4",
    })

    checks.push({
      id: "profile_citizenship",
      category: "Contact Profile",
      label: "Citizenship",
      status: contact.citizenship ? "ok" : "warning",
      detail: contact.citizenship ?? "Missing — needed for compliance",
    })

    checks.push({
      id: "profile_phone",
      category: "Contact Profile",
      label: "Phone number",
      status: contact.phone ? "ok" : "warning",
      detail: contact.phone ?? "Missing — recommended for client communication",
    })

    checks.push({
      id: "profile_passport",
      category: "Contact Profile",
      label: "Passport on file",
      status: contact.passport_on_file ? "ok" : "info",
      detail: contact.passport_on_file
        ? `Yes${contact.passport_number ? ` (${contact.passport_number})` : ""}`
        : "No passport on file",
    })

    // ═══════════════════════════════
    // CATEGORY B: Lead & Offer
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
          impact: ["Lead will no longer appear in active leads list", "No downstream workflows triggered — status label change only"],
          risk: "safe",
        } : undefined,
      })
    } else {
      checks.push({
        id: "lead_status",
        category: "Lead & Offer",
        label: "Lead record",
        status: "info",
        detail: "No lead found (may be a direct client or legacy)",
      })
    }

    if (offer) {
      checks.push({
        id: "offer_status",
        category: "Lead & Offer",
        label: "Offer status",
        status: offer.status === "completed" ? "ok" : offer.status === "signed" ? "warning" : "info",
        detail: `${offer.contract_type ?? "unknown"}: ${offer.status}`,
        fix: offer.status === "signed" ? {
          action: "set_offer_completed",
          label: "Set to completed",
          params: { offer_id: offer.id },
          description: "Marks the offer as 'completed' — confirms payment was received.",
          impact: ["Offer page shows completed to the client", "Does NOT create service deliveries automatically"],
          risk: "moderate",
        } : undefined,
      })
    } else {
      checks.push({
        id: "offer_status",
        category: "Lead & Offer",
        label: "Offer",
        status: lead ? "warning" : "info",
        detail: lead ? "Lead exists but no offer created" : "No offer found",
      })
    }

    if (pending) {
      const pendingOk = pending.status === "activated"
      checks.push({
        id: "pending_activation",
        category: "Lead & Offer",
        label: "Activation pipeline",
        status: pendingOk ? "ok" : "error",
        detail: `Status: ${pending.status}${pending.activated_at ? `, activated ${pending.activated_at.split("T")[0]}` : ""}`,
        fix: !pendingOk ? {
          action: "complete_pending_activation",
          label: "Mark as activated",
          params: { pending_id: pending.id },
          description: "Sets the pending activation to 'activated' status with today's date.",
          impact: ["Activation pipeline will be marked complete", "Does NOT trigger service delivery creation automatically"],
          risk: "safe",
        } : undefined,
      })
    }

    // Check bundled_pipelines vs actual SDs
    const bundled = offer?.bundled_pipelines ?? []
    if (bundled.length > 0 && services.length > 0) {
      const existingTypes = new Set(services.map(s => s.service_type || s.pipeline).filter(Boolean))
      const missing = bundled.filter(p => !existingTypes.has(p))
      if (missing.length > 0) {
        // For formation clients: only Company Formation is created initially.
        // Other services (ITIN, Banking, CMRA, Tax Return, Annual Renewal) are
        // created automatically at later pipeline stages (Post-Formation + Banking, Closing).
        const isFormation = offer?.contract_type === "formation"
        const hasFormationSD = existingTypes.has("Company Formation")

        if (isFormation && hasFormationSD) {
          checks.push({
            id: "offer_vs_sds",
            category: "Lead & Offer",
            label: "Additional services pending",
            status: "info",
            detail: `${missing.length} services will be created after company formation: ${missing.join(", ")}`,
          })
        } else {
          checks.push({
            id: "offer_vs_sds",
            category: "Lead & Offer",
            label: "Missing services from offer",
            status: "error",
            detail: `Offer bundles ${bundled.length} pipelines but ${missing.length} missing: ${missing.join(", ")}`,
          })
        }
      }
    }

    // ═══════════════════════════════
    // CATEGORY C: Payments
    // ═══════════════════════════════
    const paidPayments = payments.filter(p => p.status === "Paid")
    const overduePayments = payments.filter(p => p.status === "Overdue" || p.invoice_status === "Overdue")

    if (paidPayments.length > 0) {
      const totalPaid = paidPayments.reduce((s, p) => s + Number(p.amount), 0)
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
          impact: ["Payment status changes to Paid", "Client invoice (if linked) will reflect paid status"],
          risk: "moderate",
        },
      })
    } else {
      // Zero payments — check bank feeds and pending_activations before flagging error
      let matchedFeed: { amount: number; currency: string; transaction_date: string; source: string; sender_name: string } | null = null
      const hasPendingConfirmation = pending?.payment_confirmed_at != null

      // Check td_bank_feeds for matched entries matching any linked account company name
      for (const acct of linkedAccounts) {
        if (matchedFeed) break
        const companyWords = acct.company_name.replace(/\s*(LLC|INC|CORP|LTD)\.?\s*/gi, "").trim()
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

      // Parse offer amount for the fix
      let offerAmount = 0
      let offerCurrency: "EUR" | "USD" = "EUR"
      if (offer) {
        const svc = offer.services ?? []
        for (const s of svc) {
          if (!s.price || s.price.toLowerCase().includes("/year") || s.price.toLowerCase().includes("inclus")) continue
          let clean = s.price.replace(/[^0-9.,]/g, "")
          if (/^\d{1,3}\.\d{3}$/.test(clean)) clean = clean.replace(".", "")
          clean = clean.replace(",", "")
          const num = parseFloat(clean)
          if (!isNaN(num) && !s.optional) offerAmount += num
        }
        const firstPrice = svc[0]?.price ?? ""
        if (firstPrice.includes("$")) offerCurrency = "USD"
      }

      const fixAmount = matchedFeed ? matchedFeed.amount : (offerAmount || null)
      const fixCurrency = matchedFeed ? (matchedFeed.currency === "USD" ? "USD" : "EUR") as "EUR" | "USD" : offerCurrency
      const fixPaidDate = matchedFeed?.transaction_date || undefined

      if (matchedFeed || hasPendingConfirmation) {
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
            label: fixAmount ? `Record ${fixCurrency === "EUR" ? "\u20AC" : "$"}${Number(fixAmount).toLocaleString()} payment` : "Record payment",
            params: {
              contact_id: contactId,
              account_id: accountIds[0] ?? null,
              amount: fixAmount,
              currency: fixCurrency,
              payment_method: pending?.payment_method === "bank_transfer" ? "Wire Transfer" : (pending?.payment_method || "Wire Transfer"),
              description: `Setup fee — ${offer?.token || "onboarding"}`,
              paid_date: fixPaidDate,
            },
            description: `Creates a payment record for ${fixAmount ? `${fixCurrency === "EUR" ? "\u20AC" : "$"}${Number(fixAmount).toLocaleString()}` : "the setup fee"} as Paid on ${fixPaidDate || "today"}.`,
            impact: [
              "A new payment row is created linked to this contact",
              `Payment will be marked as Paid with date ${fixPaidDate || "today"}`,
              "Diagnostic will show green after this fix",
              "Finance bank feed and diagnostic will be in sync",
            ],
            risk: "safe",
          },
        })
      } else if (offer?.status === "completed") {
        checks.push({
          id: "payment_received",
          category: "Payments",
          label: "Setup payment",
          status: "error",
          detail: "No payments found — offer is completed, payment may have been received externally",
          fix: {
            action: "record_payment",
            label: offerAmount > 0 ? `Record ${offerCurrency === "EUR" ? "\u20AC" : "$"}${offerAmount.toLocaleString()} payment` : "Record payment",
            params: {
              contact_id: contactId,
              account_id: accountIds[0] ?? null,
              amount: offerAmount || null,
              currency: offerCurrency,
              payment_method: "Wire Transfer",
              description: `Setup fee — ${offer.token}`,
            },
            description: `Creates a new payment record for ${offerAmount > 0 ? `${offerCurrency === "EUR" ? "\u20AC" : "$"}${offerAmount.toLocaleString()}` : "the setup fee"} as Paid.`,
            impact: [
              "A new payment row is created linked to this contact",
              "Payment marked as Paid with today's date",
              "Finance dashboard will reflect this payment",
            ],
            risk: "moderate",
          },
        })
      } else {
        checks.push({
          id: "payment_received",
          category: "Payments",
          label: "Setup payment",
          status: payments.length === 0 && !offer ? "info" : "warning",
          detail: "No payments found",
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
    // CATEGORY D: Service Deliveries
    // ═══════════════════════════════
    if (services.length > 0) {
      for (const sd of services) {
        const sdStatus = sd.status === "active" ? "ok"
          : sd.status === "completed" ? "ok"
            : sd.status === "cancelled" ? "info"
              : "warning"

        // Check if stuck (same stage >7 days)
        const daysSinceUpdate = Math.floor((Date.now() - new Date(sd.updated_at).getTime()) / (1000 * 60 * 60 * 24))
        const isStuck = sd.status === "active" && daysSinceUpdate > 7

        checks.push({
          id: `sd_${sd.id.slice(0, 8)}`,
          category: "Services",
          label: sd.service_name ?? sd.service_type ?? "Service",
          status: isStuck ? "warning" : sdStatus,
          detail: `Status: ${sd.status}${sd.stage ? ` — ${sd.stage}` : ""}${sd.assigned_to ? ` — ${sd.assigned_to}` : ""}${isStuck ? ` (stuck ${daysSinceUpdate}d)` : ""}`,
        })
      }
    } else if (bundled.length > 0) {
      checks.push({
        id: "sd_missing",
        category: "Services",
        label: "Service deliveries",
        status: "error",
        detail: `No services found. Expected from offer: ${bundled.join(", ")}`,
        fix: {
          action: "create_service_deliveries",
          label: "Create all missing services",
          params: { pipelines: bundled, contact_id: contactId, account_id: accountIds[0] ?? null },
          description: "Creates service delivery records for all pipelines from the offer, initialized at Data Collection and assigned to Luca.",
          impact: ["New service delivery rows appear in the pipeline dashboard", "Assigned team member will see new work items"],
          risk: "safe",
        },
      })
    } else {
      checks.push({
        id: "sd_missing",
        category: "Services",
        label: "Service deliveries",
        status: offer ? "warning" : "info",
        detail: "No service deliveries found",
      })
    }

    // ═══════════════════════════════
    // CATEGORY E: Wizard & Forms
    // ═══════════════════════════════
    const primaryWizard = wizards[0]
    if (primaryWizard) {
      checks.push({
        id: "wizard_status",
        category: "Wizard & Forms",
        label: `Wizard (${primaryWizard.wizard_type})`,
        status: primaryWizard.status === "submitted" ? "ok" : "info",
        detail: primaryWizard.status === "submitted"
          ? `Submitted ${primaryWizard.updated_at.split("T")[0]}`
          : `In progress — step ${primaryWizard.current_step}`,
      })
    } else if (pending?.payment_confirmed_at) {
      const daysSincePaid = Math.floor((Date.now() - new Date(pending.payment_confirmed_at).getTime()) / (1000 * 60 * 60 * 24))
      checks.push({
        id: "wizard_status",
        category: "Wizard & Forms",
        label: "Wizard progress",
        status: daysSincePaid > 3 ? "warning" : "info",
        detail: `Not started (${daysSincePaid}d since payment)`,
      })
    }

    const contractType = offer?.contract_type ?? null
    if (contractType === "formation" || bundled.includes("Company Formation")) {
      checks.push({
        id: "formation_form",
        category: "Wizard & Forms",
        label: "Formation submission",
        status: formationSub
          ? (formationSub.status === "completed" || formationSub.status === "reviewed" ? "ok" : "info")
          : "info",
        detail: formationSub
          ? `Status: ${formationSub.status}${formationSub.completed_at ? ` (${formationSub.completed_at.split("T")[0]})` : ""}`
          : "No formation form submitted",
      })
    }

    if (contractType === "onboarding" || (!contractType && !bundled.includes("Company Formation"))) {
      if (onboardingSub) {
        checks.push({
          id: "onboarding_form",
          category: "Wizard & Forms",
          label: "Onboarding submission",
          status: onboardingSub.status === "completed" || onboardingSub.status === "reviewed" ? "ok" : "info",
          detail: `Status: ${onboardingSub.status}`,
        })
      }
    }

    // Check passport in documents
    const hasPassportDoc = docs.some(d =>
      (d.document_type_name ?? "").toLowerCase().includes("passport") ||
      (d.file_name ?? "").toLowerCase().includes("passport")
    )
    if (!hasPassportDoc && (bundled.includes("Company Formation") || bundled.includes("ITIN"))) {
      checks.push({
        id: "passport_doc",
        category: "Wizard & Forms",
        label: "Passport document",
        status: "warning",
        detail: "No passport document uploaded — required for formation/ITIN",
      })
    }

    // ═══════════════════════════════
    // CATEGORY F: Portal Access
    // ═══════════════════════════════
    checks.push({
      id: "portal_user",
      category: "Portal Access",
      label: "Portal auth user",
      status: authUser ? "ok" : "error",
      detail: authUser ? `Exists (${authUser.email})` : "No portal login — client cannot access portal",
      fix: !authUser && contactEmail ? {
        action: "create_portal_user",
        label: "Create portal login",
        params: { contact_id: contactId, email: contactEmail, full_name: contact.full_name },
        description: "Creates (or repairs) a portal login for this client. Sets full auth metadata, portal_account flag on accounts, and sends welcome email with credentials.",
        impact: ["Auth user is created or repaired with full metadata (contact_id, account_ids, portal_tier)", "portal_account flag set on all linked accounts", "Welcome email with temp password sent automatically", "Client can log in at portal.tonydurante.us"],
        risk: "high",
      } : undefined,
    })

    // Check tier — strongest signal first
    const hasPaidPayment = paidPayments.length > 0
    const hasCompletedForm = formationSub?.status === "completed" || formationSub?.status === "reviewed"
      || onboardingSub?.status === "completed" || onboardingSub?.status === "reviewed"
    const hasActiveAccount = linkedAccounts.some(a => a.status === "Active")
    const hasActiveService = services.some(s => s.status === "active")
    // Active account = strongest signal (company exists, client is active)
    const expectedTier = hasActiveAccount ? "active"
      : (hasCompletedForm || hasActiveService) ? "active"
        : hasPaidPayment ? "onboarding"
          : "lead"

    const currentTier = contact.portal_tier as string | null
    checks.push({
      id: "portal_tier",
      category: "Portal Access",
      label: "Portal tier",
      status: currentTier === expectedTier ? "ok" : currentTier ? "warning" : "error",
      detail: `Current: ${currentTier ?? "null"}, expected: ${expectedTier}`,
      fix: currentTier !== expectedTier ? {
        action: "set_portal_tier",
        label: `Set to ${expectedTier}`,
        params: { contact_id: contactId, tier: expectedTier, account_ids: accountIds },
        description: `Updates portal_tier to '${expectedTier}' on the contact, all linked accounts, and auth metadata.`,
        impact: [
          "Contact + all linked accounts updated to same tier",
          "Auth metadata synced so portal reflects new tier immediately",
          "Client sees different portal sections based on tier",
        ],
        risk: "high",
      } : undefined,
    })

    // Last login check
    if (authUser) {
      if (!authUser.last_sign_in_at) {
        checks.push({
          id: "portal_login",
          category: "Portal Access",
          label: "Last login",
          status: "warning",
          detail: "Never logged in",
        })
      } else {
        const daysSinceLogin = Math.floor((Date.now() - new Date(authUser.last_sign_in_at).getTime()) / (1000 * 60 * 60 * 24))
        checks.push({
          id: "portal_login",
          category: "Portal Access",
          label: "Last login",
          status: daysSinceLogin > 7 ? "warning" : "ok",
          detail: daysSinceLogin > 7
            ? `${daysSinceLogin}d ago — may need re-engagement`
            : `${daysSinceLogin}d ago`,
        })
      }
    }

    // Tier sync between contact and accounts
    for (const acc of linkedAccounts) {
      if (acc.portal_tier && acc.portal_tier !== currentTier) {
        checks.push({
          id: `tier_sync_${acc.id.slice(0, 8)}`,
          category: "Portal Access",
          label: `Tier sync: ${acc.company_name}`,
          status: "warning",
          detail: `Account tier (${acc.portal_tier}) != Contact tier (${currentTier})`,
          fix: {
            action: "sync_portal_tier",
            label: "Sync to contact tier",
            params: { contact_id: contactId, account_id: acc.id, tier: currentTier ?? expectedTier },
            description: "Syncs portal_tier between the account and contact records.",
            impact: ["Both records updated to same tier", "Portal access becomes consistent"],
            risk: "high",
          },
        })
      }
    }

    // ═══════════════════════════════
    // CATEGORY G: Linked Accounts
    // ═══════════════════════════════
    if (linkedAccounts.length === 0) {
      checks.push({
        id: "linked_accounts",
        category: "Linked Accounts",
        label: "Linked companies",
        status: "info",
        detail: "No linked companies (early stage or individual services)",
      })
    } else {
      for (const acc of linkedAccounts) {
        // Mini health check per account
        const accSds = services.filter(s => s.account_id === acc.id)
        const accOa = oaAgreements.find(o => o.account_id === acc.id)
        const accLease = leaseAgreements.find(l => l.account_id === acc.id)

        const issues: string[] = []
        if (!acc.drive_folder_id) issues.push("no Drive folder")
        if (!acc.ein_number && accSds.some(s => (s.stage ?? "").includes("EIN") || (s.stage ?? "").includes("Post-Formation"))) {
          issues.push("missing EIN")
        }
        if (!accOa && acc.status === "Active") issues.push("no OA")
        if (!accLease && acc.status === "Active") issues.push("no Lease")

        checks.push({
          id: `account_${acc.id.slice(0, 8)}`,
          category: "Linked Accounts",
          label: acc.company_name,
          status: issues.length > 0 ? "warning" : "ok",
          detail: issues.length > 0
            ? `Issues: ${issues.join(", ")}`
            : `${acc.status ?? "Unknown"} — ${acc.entity_type ?? ""} ${acc.state_of_formation ?? ""}`.trim(),
        })
      }
    }

    // ═══════════════════════════════
    // CATEGORY H: Documents
    // ═══════════════════════════════
    const hasFormationDocs = bundled.includes("Company Formation") || bundled.includes("ITIN")
    if (hasFormationDocs) {
      const hasW7 = docs.some(d => (d.file_name ?? "").toLowerCase().includes("w-7") || (d.document_type_name ?? "").toLowerCase().includes("w-7"))
      if (bundled.includes("ITIN") && !hasW7) {
        checks.push({
          id: "doc_w7",
          category: "Documents",
          label: "W-7 document",
          status: "info",
          detail: "No W-7 document uploaded yet",
        })
      }
    }

    checks.push({
      id: "doc_count",
      category: "Documents",
      label: "Documents on file",
      status: docs.length > 0 ? "ok" : "info",
      detail: `${docs.length} document${docs.length !== 1 ? "s" : ""} linked to this contact`,
    })

    // ─── Summary ───
    const summary = {
      ok: checks.filter(c => c.status === "ok").length,
      warning: checks.filter(c => c.status === "warning").length,
      error: checks.filter(c => c.status === "error").length,
      info: checks.filter(c => c.status === "info").length,
      total: checks.length,
    }

    return NextResponse.json({
      contact: { id: contactId, full_name: contact.full_name, portal_tier: contact.portal_tier, email: contact.email },
      checks,
      summary,
    })
  } catch (e) {
    console.error("[diagnose-contact] Error:", e)
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

// ─── POST: Execute Fix ───

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { contact_id, action, params } = body

    if (!contact_id || !action) {
      return NextResponse.json({ error: "Missing contact_id or action" }, { status: 400 })
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
          .eq("id", params.offer_id)
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
            account_id: params.account_id || null,
            contact_id: params.contact_id || contact_id,
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
            notes: `Recorded via contact diagnostic fix${bankName ? ` — bank: ${bankName}` : ""}`,
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

        const amt = params.amount ? `${params.currency === "USD" ? "$" : "\u20AC"}${Number(params.amount).toLocaleString()}` : "unknown amount"
        result = { success: !error, detail: error ? error.message : `Payment recorded: ${amt} (${newPayment?.id?.slice(0, 8)})` }
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

        const portalAccountIds = (contactAccountLinks || []).map((a: { account_id: string }) => a.account_id)
        const portalTier = contactForPortal?.portal_tier || "active"
        const portalEmail = (contactForPortal?.email || params.email) as string
        const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

        // Check if user already exists (paginated — P1.9)
        const existingPortalUser = await findAuthUserByEmail(portalEmail)

        if (existingPortalUser) {
          // Fix metadata on existing user
          await supabaseAdmin.auth.admin.updateUserById(existingPortalUser.id, {
            password: tempPassword,
            app_metadata: {
              ...existingPortalUser.app_metadata,
              role: "client",
              contact_id: params.contact_id,
              portal_tier: portalTier,
              ...(portalAccountIds.length > 0 ? { account_ids: portalAccountIds } : {}),
            },
            user_metadata: {
              ...existingPortalUser.user_metadata,
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
              ...(portalAccountIds.length > 0 ? { account_ids: portalAccountIds } : {}),
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
        if (portalAccountIds.length > 0) {
          await supabaseAdmin
            .from("accounts")
            .update({
              portal_account: true,
              portal_tier: portalTier,
              portal_created_date: new Date().toISOString().split("T")[0],
            })
            .in("id", portalAccountIds)
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

        result = { success: true, detail: existingPortalUser ? "Portal user repaired + credentials resent" : "Portal user created + welcome email sent" }
        break
      }

      case "set_portal_tier": {
        const tier = params.tier as string
        // Update contact
        const { error: contactErr } = await supabaseAdmin
          .from("contacts")
          .update({ portal_tier: tier, updated_at: new Date().toISOString() })
          .eq("id", params.contact_id)

        // Update all linked accounts
        const accIds = params.account_ids as string[] | undefined
        if (accIds && accIds.length > 0) {
          await supabaseAdmin
            .from("accounts")
            .update({ portal_tier: tier, updated_at: new Date().toISOString() })
            .in("id", accIds)
        }

        // Sync auth metadata
        const { data: contactData } = await supabaseAdmin
          .from("contacts")
          .select("email")
          .eq("id", params.contact_id)
          .single()
        if (contactData?.email) {
          try {
            const authU = await findAuthUserByEmail(contactData.email as string)
            if (authU) {
              await supabaseAdmin.auth.admin.updateUserById(authU.id, {
                app_metadata: { ...authU.app_metadata, portal_tier: tier },
              })
            }
          } catch {
            // Non-critical
          }
        }

        result = { success: !contactErr, detail: contactErr ? contactErr.message : `Portal tier set to ${tier} (contact + accounts + auth)` }
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
            service_name: `${params.service_type} — ${params.contact_name || "Contact"}`,
            account_id: (params.account_id as string) || null,
            contact_id: (params.contact_id as string) || contact_id,
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
              contact_id: (params.contact_id as string) || contact_id,
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

      default:
        result = { success: false, detail: `Unknown action: ${action}` }
    }

    // Log action
    await supabaseAdmin.from("action_log").insert({
      actor: "crm-admin",
      action_type: "diagnose_contact_fix",
      table_name: "contacts",
      record_id: contact_id,
      summary: `Contact diagnostic fix: ${action} — ${result.detail}`,
      details: { action, params, result },
    })

    return NextResponse.json(result)
  } catch (e) {
    console.error("[diagnose-contact] Fix error:", e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
