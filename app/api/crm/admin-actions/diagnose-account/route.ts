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
      supabaseAdmin.from("payments").select("id, amount, amount_currency, status, payment_method, paid_date, invoice_status, description")
        .eq("account_id", accountId).order("created_at", { ascending: false }),
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
      // Auth user — check portal_account flag + verify in auth.users
      Promise.resolve().then(async () => {
        if (!contactEmail) return { data: [] as { id: string; email: string }[] }
        // First check account.portal_account flag (reliable)
        if (account.portal_account) {
          return { data: [{ id: "from-flag", email: contactEmail }] }
        }
        // Fallback: check auth.users directly
        try {
          const { data } = await supabaseAdmin.rpc("exec_sql", {
            query: `SELECT id::text, email FROM auth.users WHERE LOWER(email) = LOWER('${contactEmail.replace(/'/g, "''")}') LIMIT 1`
          })
          const rows = Array.isArray(data) ? data : (data as { rows?: unknown[] })?.rows || []
          return { data: rows as { id: string; email: string }[] }
        } catch {
          return { data: [] as { id: string; email: string }[] }
        }
      }),
      // Tax return record
      supabaseAdmin.from("tax_returns").select("id, tax_year, status")
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
    const formationSub = (formationResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string } | undefined
    const onboardingSub = (onboardingResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string } | undefined
    const taxForm = (taxFormResult.data as unknown[])?.[0] as { id: string; token: string; status: string; completed_at: string } | undefined
    const oa = (oaResult.data as unknown[])?.[0] as { id: string; token: string; status: string; signed_at: string } | undefined
    const lease = (leaseResult.data as unknown[])?.[0] as { id: string; token: string; status: string; signed_at: string; suite_number: string } | undefined
    const ss4 = (ss4Result.data as unknown[])?.[0] as { id: string; token: string; status: string } | undefined
    const bankingForms = (bankingResult.data || []) as { id: string; token: string; status: string; provider: string; submitted_data: Record<string, unknown> }[]
    const authUsers = (authUsersResult.data || []) as { id: string; email: string }[]
    const taxReturn = (taxReturnResult.data as unknown[])?.[0] as { id: string; tax_year: number; status: string } | undefined
    const deadlines = (deadlinesResult.data || []) as { id: string; deadline_type: string; due_date: string; status: string }[]

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
        },
      })
    } else {
      // Zero payments — offer may be completed (transition client paid externally)
      // Parse offer amount for the fix button
      let offerAmount = 0
      let offerCurrency: "EUR" | "USD" = "EUR"
      if (offer) {
        const svc = (offer as unknown as { services: Array<{ price: string; optional?: boolean }> }).services || []
        for (const s of svc) {
          if (!s.price || s.price.toLowerCase().includes("/year") || s.price.toLowerCase().includes("inclus")) continue
          const clean = s.price.replace(/[^0-9.,]/g, "").replace(",", "")
          const num = parseFloat(clean)
          if (!isNaN(num)) offerAmount += num
        }
        const firstPrice = svc[0]?.price || ""
        if (firstPrice.includes("$")) offerCurrency = "USD"
      }

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
        } : undefined,
      })
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
    // CATEGORY: Service Delivery
    // ═══════════════════════════════
    const bundledPipelines = offer?.bundled_pipelines || []

    // Show ALL service deliveries with their real status
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
    } else if (bundledPipelines.length > 0) {
      checks.push({
        id: "sd_missing",
        category: "Services",
        label: "Service deliveries",
        status: "error",
        detail: `No services found. Expected from offer: ${bundledPipelines.join(", ")}`,
        fix: {
          action: "create_service_deliveries",
          label: "Create all missing services",
          params: { pipelines: bundledPipelines, account_id: accountId, contact_id: contactId },
        },
      })
    } else {
      checks.push({
        id: "sd_missing",
        category: "Services",
        label: "Service deliveries",
        status: "warning",
        detail: "No service deliveries found",
      })
    }

    // Check for missing bundled pipelines
    for (const pipeline of bundledPipelines) {
      const exists = services.some(s => s.service_type === pipeline)
      if (!exists) {
        checks.push({
          id: `sd_missing_${pipeline.toLowerCase().replace(/\s+/g, "_")}`,
          category: "Services",
          label: `Missing: ${pipeline}`,
          status: "error",
          detail: `Expected from offer but not created`,
          fix: {
            action: "create_service_delivery",
            label: `Create ${pipeline}`,
            params: { service_type: pipeline, account_id: accountId, contact_id: contactId },
          },
        })
      }
    }

    // ═══════════════════════════════
    // CATEGORY: Forms
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
      } : undefined,
    })

    if (account.ein_number || ss4) {
      checks.push({
        id: "ss4_status",
        category: "Documents",
        label: "SS-4 Application",
        status: ss4 ? "ok" : account.ein_number ? "ok" : "info",
        detail: ss4 ? `Status: ${ss4.status}` : account.ein_number ? `EIN: ${account.ein_number}` : "Not created",
      })
    }

    // ═══════════════════════════════
    // CATEGORY: Portal Access
    // ═══════════════════════════════
    const authUser = authUsers[0]
    const contactTier = primaryContact?.portal_tier || null
    const accountTier = account.portal_tier || null

    checks.push({
      id: "portal_user",
      category: "Portal",
      label: "Portal auth user",
      status: authUser ? "ok" : "error",
      detail: authUser ? `Exists (${authUser.email})` : "No portal login — client cannot access portal",
      fix: !authUser && contactEmail ? {
        action: "create_portal_user",
        label: "Create portal login",
        params: { contact_id: contactId, email: contactEmail },
      } : undefined,
    })

    // Determine expected tier — account.status is the strongest signal for legacy clients
    const isActiveAccount = account.status === "Active"
    const hasPaidPayment = paidPayments.length > 0
    const hasCompletedForm = formationSub?.status === "completed" || onboardingSub?.status === "completed"
    const hasCompletedServices = services.some(s => s.status === "Completed" || s.status === "completed")
    const expectedTier = (isActiveAccount && (hasCompletedServices || hasCompletedForm)) ? "active"
      : (isActiveAccount && account.portal_account) ? "active"  // legacy clients with portal access
        : hasCompletedForm ? "active"
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
        const today = new Date().toISOString().split("T")[0]
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
            paid_date: today,
            issue_date: today,
            period: "Setup",
            year: new Date().getFullYear(),
            installment: "Setup",
            notes: `Recorded via diagnostic fix${params.offer_token ? ` — offer: ${params.offer_token}` : ""}`,
          })
          .select("id")
          .single()
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
        const { error } = await supabaseAdmin
          .from("service_deliveries")
          .insert({
            service_type: params.service_type,
            account_id: params.account_id || null,
            contact_id: params.contact_id || null,
            status: "active",
            stage: "Data Collection",
            stage_order: 1,
            assigned_to: "Luca",
          })
        result = { success: !error, detail: error ? error.message : `${params.service_type} created` }
        break
      }

      case "create_service_deliveries": {
        const pipelines = params.pipelines as string[]
        let created = 0
        for (const p of pipelines) {
          const { error } = await supabaseAdmin
            .from("service_deliveries")
            .insert({
              service_type: p,
              account_id: params.account_id || null,
              contact_id: params.contact_id || null,
              status: "active",
              stage: "Data Collection",
              stage_order: 1,
              assigned_to: "Luca",
            })
          if (!error) created++
        }
        result = { success: created > 0, detail: `Created ${created}/${pipelines.length} services` }
        break
      }

      case "create_portal_user": {
        const { data: newUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
          email: params.email as string,
          password: `TD-${Date.now().toString(36)}!`,
          email_confirm: true,
          user_metadata: { full_name: params.full_name || "Client" },
        })
        if (!authErr && newUser) {
          await supabaseAdmin
            .from("contacts")
            .update({ portal_tier: "lead", updated_at: new Date().toISOString() })
            .eq("id", params.contact_id)
        }
        result = { success: !authErr, detail: authErr ? authErr.message : "Portal user created" }
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
