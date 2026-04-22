/**
 * Client Chain Audit API
 *
 * GET  ?contact_id=UUID — Run full lifecycle chain audit on a contact (+ all linked accounts)
 * POST { contact_id, action, params } — Execute a confirmed fix
 *
 * Checks the 10-link chain:
 *   1. Lead → Contact link
 *   2. Offer exists + status
 *   3. Pending Activation status
 *   4. Payment record
 *   5. Account exists + account_type
 *   6. Service Deliveries vs bundled_pipelines
 *   7. Portal user + tier
 *   8. Data collection form
 *   9. Documents (passport)
 *  10. Invoice / QB sync
 *
 * Also: orphan detection, account_type validation, portal transition readiness.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { INTERNAL_BASE_URL } from "@/lib/config"
import { classifyAccount } from "@/lib/account-classification"
import { createSD } from "@/lib/operations/service-delivery"
import type { Json } from "@/lib/database.types"

// ─── Types ───

interface ChainCheck {
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

interface AccountAudit {
  account_id: string
  company_name: string
  entity_type: string | null
  status: string | null
  account_type: string | null
  role: string | null
  checks: ChainCheck[]
}

interface ChainAuditResult {
  contact: {
    id: string
    full_name: string
    email: string | null
    portal_tier: string | null
  }
  global_checks: ChainCheck[]
  account_audits: AccountAudit[]
  summary: { ok: number; warning: number; error: number; info: number; total: number }
}

// ─── Helpers ───

function summarize(checks: ChainCheck[]): { ok: number; warning: number; error: number; info: number; total: number } {
  const s = { ok: 0, warning: 0, error: 0, info: 0, total: checks.length }
  for (const c of checks) s[c.status]++
  return s
}

/**
 * Map a pending_activation payment_method value to a display label used on
 * the payments row. pending_activations stores lowercase tokens
 * (whop / stripe / wire / bank_transfer / unknown); payments.payment_method
 * is a free-text display string. Prior code was a binary whop-vs-wire
 * ternary that mislabeled Stripe card payments as "Wire Transfer".
 */
function labelPaymentMethod(method: string | null | undefined): string {
  const v = (method || "").trim().toLowerCase()
  switch (v) {
    case "whop": return "Whop"
    case "stripe": return "Stripe"
    case "wire": return "Wire Transfer"
    case "bank_transfer": return "Bank Transfer"
    case "card": return "Card"
    case "ach": return "ACH"
    case "cash": return "Cash"
    case "crypto": return "Crypto"
    case "":
    case "unknown": return "Unknown"
    default:
      // Unknown value — pass through capitalized so it's visible rather
      // than silently mislabeled.
      return v.charAt(0).toUpperCase() + v.slice(1)
  }
}

// ─── GET: Run Chain Audit ───

export async function GET(req: NextRequest) {
  const contactId = req.nextUrl.searchParams.get("contact_id")
  if (!contactId) {
    return NextResponse.json({ error: "Missing contact_id" }, { status: 400 })
  }

  try {
    // ── Load contact ──
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, first_name, last_name, email, email_2, phone, citizenship, residency, passport_on_file, passport_number, date_of_birth, portal_tier, status, qb_customer_id, language")
      .eq("id", contactId)
      .single()

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    const contactEmail = contact.email as string | null
    const contactEmail2 = contact.email_2 as string | null
    const allEmails = [contactEmail, contactEmail2].filter(Boolean) as string[]

    // ── Load linked accounts ──
    const { data: accountContacts } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id, role, accounts(id, company_name, status, entity_type, state_of_formation, ein_number, drive_folder_id, portal_tier, portal_account, account_type, formation_date, physical_address, services_bundle)")
      .eq("contact_id", contactId)

    const linkedAccounts = (accountContacts ?? []).map(ac => {
      const a = ac.accounts as unknown as {
        id: string; company_name: string; status: string | null; entity_type: string | null
        state_of_formation: string | null; ein_number: string | null; drive_folder_id: string | null
        portal_tier: string | null; portal_account: boolean | null; account_type: string | null
        formation_date: string | null; physical_address: string | null; services_bundle: string[] | null
      }
      return { ...a, role: ac.role }
    })
    const accountIds = linkedAccounts.map(a => a.id)

    // ── Load all related data in parallel ──
    const [
      leadsResult,
      allLeadsForContactResult,
      offersResult,
      pendingResult,
      paymentsResult,
      servicesResult,
      formationSubResult,
      onboardingSubResult,
      docsResult,
      oaResult,
      leaseResult,
      ss4Result,
      taxReturnsResult,
    ] = await Promise.all([
      // Leads linked by converted_to_contact_id
      supabaseAdmin.from("leads")
        .select("id, full_name, email, phone, status, converted_to_contact_id, converted_to_account_id, converted_at, offer_status, offer_link, reason")
        .eq("converted_to_contact_id", contactId),
      // Leads by email (may not be linked yet)
      allEmails.length > 0
        ? supabaseAdmin.from("leads")
            .select("id, full_name, email, phone, status, converted_to_contact_id, converted_to_account_id, converted_at, offer_status, offer_link, reason")
            .or(allEmails.map(e => `email.ilike.${e}`).join(","))
        : { data: [] },
      // Offers by email
      allEmails.length > 0
        ? supabaseAdmin.from("offers")
            .select("id, token, status, contract_type, bundled_pipelines, client_email, client_name, lead_id, account_id, payment_type, services")
            .or(allEmails.map(e => `client_email.ilike.${e}`).join(","))
            .order("created_at", { ascending: false })
        : { data: [] },
      // Pending activations by email
      allEmails.length > 0
        ? supabaseAdmin.from("pending_activations")
            .select("id, offer_token, lead_id, client_name, client_email, amount, currency, payment_method, status, signed_at, payment_confirmed_at, activated_at, prepared_steps, confirmation_mode, portal_invoice_id, notes")
            .or(allEmails.map(e => `client_email.ilike.${e}`).join(","))
            .order("created_at", { ascending: false })
        : { data: [] },
      // Payments (contact + accounts)
      supabaseAdmin.from("payments")
        .select("id, amount, amount_currency, status, payment_method, paid_date, description, account_id, contact_id, invoice_number")
        .or(`contact_id.eq.${contactId}${accountIds.length > 0 ? `,account_id.in.(${accountIds.join(",")})` : ""}`)
        .order("created_at", { ascending: false }),
      // Service deliveries (contact + accounts)
      supabaseAdmin.from("service_deliveries")
        .select("id, service_name, service_type, pipeline, stage, stage_order, status, assigned_to, account_id, contact_id, notes, updated_at")
        .or(`contact_id.eq.${contactId}${accountIds.length > 0 ? `,account_id.in.(${accountIds.join(",")})` : ""}`)
        .order("updated_at", { ascending: false }),
      // Formation submissions
      supabaseAdmin.from("formation_submissions")
        .select("id, token, status, lead_id, contact_id, completed_at")
        .or(`contact_id.eq.${contactId}${allEmails.length > 0 ? "" : ""}`)
        .order("created_at", { ascending: false })
        .limit(5),
      // Onboarding submissions
      supabaseAdmin.from("onboarding_submissions")
        .select("id, token, status, contact_id, completed_at")
        .eq("contact_id", contactId)
        .limit(5),
      // Documents (contact-level)
      supabaseAdmin.from("documents")
        .select("id, file_name, document_type_name, category_name, account_id, portal_visible")
        .or(`contact_id.eq.${contactId}${accountIds.length > 0 ? `,account_id.in.(${accountIds.join(",")})` : ""}`),
      // OA agreements
      accountIds.length > 0
        ? supabaseAdmin.from("oa_agreements").select("id, status, signed_at, account_id").in("account_id", accountIds)
        : { data: [] },
      // Lease agreements
      accountIds.length > 0
        ? supabaseAdmin.from("lease_agreements").select("id, status, signed_at, account_id").in("account_id", accountIds)
        : { data: [] },
      // SS-4 applications
      accountIds.length > 0
        ? supabaseAdmin.from("ss4_applications").select("id, status, account_id, ein_number").in("account_id", accountIds)
        : { data: [] },
      // Tax returns (for classification signal)
      accountIds.length > 0
        ? supabaseAdmin.from("tax_returns").select("id, account_id, tax_year, extension_filed, status, first_year_skip").in("account_id", accountIds).order("tax_year", { ascending: false })
        : { data: [] },
    ])

    // ── Auth user check (paginated — P1.9) ──
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

    // ── Parse results ──
    const linkedLeads = (leadsResult.data ?? []) as Array<{
      id: string; full_name: string; email: string; phone: string | null; status: string
      converted_to_contact_id: string | null; converted_to_account_id: string | null
      converted_at: string | null; offer_status: string | null; offer_link: string | null; reason: string | null
    }>
    const emailLeads = (allLeadsForContactResult.data ?? []) as typeof linkedLeads
    // Merge: linked + email-matched (deduplicate by id)
    const seenLeadIds = new Set(linkedLeads.map(l => l.id))
    const unlinkedLeads = emailLeads.filter(l => !seenLeadIds.has(l.id))
    const allLeads = [...linkedLeads, ...unlinkedLeads]

    // ── Second pass: fetch offers/pending by lead emails + lead IDs ──
    // This catches the Mocellin case where lead email ≠ contact email
    const leadEmails = allLeads.map(l => l.email).filter(Boolean).filter(e => !allEmails.includes(e))
    const leadIds = allLeads.map(l => l.id)

    if (leadEmails.length > 0 || leadIds.length > 0) {
      const [extraOffersResult, extraPendingResult] = await Promise.all([
        // Offers by lead email or lead_id
        supabaseAdmin.from("offers")
          .select("id, token, status, contract_type, bundled_pipelines, client_email, client_name, lead_id, account_id, payment_type, services")
          .or([
            ...leadEmails.map(e => `client_email.ilike.${e}`),
            ...leadIds.map(id => `lead_id.eq.${id}`),
          ].join(","))
          .order("created_at", { ascending: false }),
        // Pending activations by lead email or lead_id
        supabaseAdmin.from("pending_activations")
          .select("id, offer_token, lead_id, client_name, client_email, amount, currency, payment_method, status, signed_at, payment_confirmed_at, activated_at, prepared_steps, confirmation_mode, portal_invoice_id, notes")
          .or([
            ...leadEmails.map(e => `client_email.ilike.${e}`),
            ...leadIds.map(id => `lead_id.eq.${id}`),
          ].join(","))
          .order("created_at", { ascending: false }),
      ])
      // Merge extra offers (deduplicate by id)
      const existingOfferIds = new Set((offersResult.data ?? []).map((o: { id: string }) => o.id))
      for (const o of (extraOffersResult.data ?? []) as { id: string }[]) {
        if (!existingOfferIds.has(o.id)) {
          ;(offersResult.data as unknown[])?.push(o)
        }
      }
      // Merge extra pending activations
      const existingPaIds = new Set((pendingResult.data ?? []).map((p: { id: string }) => p.id))
      for (const p of (extraPendingResult.data ?? []) as { id: string }[]) {
        if (!existingPaIds.has(p.id)) {
          ;(pendingResult.data as unknown[])?.push(p)
        }
      }
    }

    const offers = (offersResult.data ?? []) as Array<{
      id: string; token: string; status: string; contract_type: string | null
      bundled_pipelines: string[] | null; client_email: string; client_name: string
      lead_id: string | null; account_id: string | null; payment_type: string | null
      services: Array<{ name?: string; price?: string; optional?: boolean }> | null
    }>
    const pendingActivations = (pendingResult.data ?? []) as Array<{
      id: string; offer_token: string; lead_id: string | null; client_name: string
      client_email: string; amount: number | null; currency: string | null
      payment_method: string | null; status: string; signed_at: string | null
      payment_confirmed_at: string | null; activated_at: string | null
      prepared_steps: unknown[] | null; confirmation_mode: string | null
      portal_invoice_id: string | null; notes: string | null
    }>
    const payments = (paymentsResult.data ?? []) as Array<{
      id: string; amount: number; amount_currency: string; status: string
      payment_method: string | null; paid_date: string | null; description: string | null
      account_id: string | null; contact_id: string | null; invoice_number: string | null
    }>
    const services = (servicesResult.data ?? []) as Array<{
      id: string; service_name: string; service_type: string; pipeline: string | null
      stage: string | null; stage_order: number | null; status: string
      assigned_to: string | null; account_id: string | null; contact_id: string | null
      notes: string | null; updated_at: string
    }>
    const formationSubs = (formationSubResult.data ?? []) as Array<{
      id: string; token: string; status: string; lead_id: string | null
      contact_id: string | null; completed_at: string | null
    }>
    const onboardingSubs = (onboardingSubResult.data ?? []) as Array<{
      id: string; token: string; status: string; contact_id: string | null; completed_at: string | null
    }>
    const docs = (docsResult.data ?? []) as Array<{
      id: string; file_name: string; document_type_name: string | null
      category_name: string | null; account_id: string | null; portal_visible: boolean | null
    }>
    const oaAgreements = (oaResult.data ?? []) as Array<{ id: string; status: string; signed_at: string | null; account_id: string }>
    const leaseAgreements = (leaseResult.data ?? []) as Array<{ id: string; status: string; signed_at: string | null; account_id: string }>
    const ss4Apps = (ss4Result.data ?? []) as Array<{ id: string; status: string; account_id: string; ein_number: string | null }>
    const taxReturns = (taxReturnsResult.data ?? []) as Array<{ id: string; account_id: string; tax_year: number; extension_filed: boolean; status: string; first_year_skip: boolean }>

    // ═══════════════════════════════════════
    // GLOBAL CHECKS (contact-level)
    // ═══════════════════════════════════════
    const globalChecks: ChainCheck[] = []

    // ── 1. Lead → Contact link ──
    if (allLeads.length > 0) {
      for (const lead of allLeads) {
        const isLinked = lead.converted_to_contact_id === contactId
        if (isLinked) {
          globalChecks.push({
            id: `lead_link_${lead.id.slice(0, 8)}`,
            category: "Lead → Contact",
            label: `Lead: ${lead.full_name}`,
            status: "ok",
            detail: `Linked (${lead.status})${lead.converted_at ? ` on ${lead.converted_at.split("T")[0]}` : ""}`,
          })
        } else {
          // Lead found by email but not linked
          globalChecks.push({
            id: `lead_link_${lead.id.slice(0, 8)}`,
            category: "Lead → Contact",
            label: `Lead: ${lead.full_name} (${lead.email})`,
            status: "error",
            detail: `Lead status: ${lead.status} — NOT linked to this contact (converted_to_contact_id = ${lead.converted_to_contact_id ?? "NULL"})`,
            fix: {
              action: "link_lead_to_contact",
              label: "Link lead to this contact",
              params: { lead_id: lead.id, contact_id: contactId },
              description: `Sets leads.converted_to_contact_id = ${contact.full_name} and status = Converted.`,
              impact: [
                "Lead will be linked to this contact in CRM",
                "Lead status set to Converted",
                "converted_at set to today",
              ],
              risk: "safe",
            },
          })
        }
      }
    } else {
      globalChecks.push({
        id: "lead_link_none",
        category: "Lead → Contact",
        label: "Lead record",
        status: "info",
        detail: "No leads found (legacy or direct client)",
      })
    }

    // Also check: are there leads with a DIFFERENT email that mention this contact name?
    // This catches the Mocellin case (lead email ≠ contact email)
    if (allLeads.length === 0 && contact.full_name) {
      const nameParts = (contact.full_name as string).split(" ")
      const lastName = nameParts[nameParts.length - 1]
      if (lastName && lastName.length >= 3) {
        const { data: nameLeads } = await supabaseAdmin
          .from("leads")
          .select("id, full_name, email, status, converted_to_contact_id")
          .ilike("full_name", `%${lastName}%`)
          .limit(5)

        const unlinkedNameLeads = (nameLeads ?? []).filter(
          l => l.converted_to_contact_id !== contactId && !allEmails.includes(l.email?.toLowerCase() ?? "")
        )

        // Fetch offers/pending for name-matched leads too
        if (unlinkedNameLeads.length > 0) {
          const nameLeadEmails = unlinkedNameLeads.map(l => l.email).filter(Boolean) as string[]
          const nameLeadIds = unlinkedNameLeads.map(l => l.id)
          const orParts = [
            ...nameLeadEmails.map(e => `client_email.ilike.${e}`),
            ...nameLeadIds.map(id => `lead_id.eq.${id}`),
          ]
          if (orParts.length > 0) {
            const [nlOffersResult, nlPendingResult] = await Promise.all([
              supabaseAdmin.from("offers")
                .select("id, token, status, contract_type, bundled_pipelines, client_email, client_name, lead_id, account_id, payment_type, services")
                .or(orParts.join(","))
                .order("created_at", { ascending: false }),
              supabaseAdmin.from("pending_activations")
                .select("id, offer_token, lead_id, client_name, client_email, amount, currency, payment_method, status, signed_at, payment_confirmed_at, activated_at, prepared_steps, confirmation_mode, portal_invoice_id, notes")
                .or(orParts.join(","))
                .order("created_at", { ascending: false }),
            ])
            const existingOfferIds2 = new Set(offers.map(o => o.id))
            for (const o of (nlOffersResult.data ?? []) as typeof offers[number][]) {
              if (!existingOfferIds2.has(o.id)) offers.push(o)
            }
            const existingPaIds2 = new Set(pendingActivations.map(p => p.id))
            for (const p of (nlPendingResult.data ?? []) as typeof pendingActivations[number][]) {
              if (!existingPaIds2.has(p.id)) pendingActivations.push(p)
            }
          }
        }

        for (const lead of unlinkedNameLeads) {
          globalChecks.push({
            id: `lead_name_${lead.id.slice(0, 8)}`,
            category: "Lead → Contact",
            label: `Possible match: ${lead.full_name} (${lead.email})`,
            status: "warning",
            detail: `Found by last name "${lastName}" — different email. Status: ${lead.status}. converted_to_contact_id = ${lead.converted_to_contact_id ?? "NULL"}`,
            fix: {
              action: "link_lead_to_contact",
              label: "Link this lead to contact",
              params: { lead_id: lead.id, contact_id: contactId },
              description: `Links lead "${lead.full_name}" to contact "${contact.full_name}". NOTE: Lead email (${lead.email}) differs from contact email (${contactEmail}).`,
              impact: [
                "Lead will be linked to this contact",
                "Lead status set to Converted, converted_at = today",
                "This does NOT change the contact's email",
              ],
              risk: "moderate",
            },
          })
        }
      }
    }

    // ── 2. Offer status ──
    if (offers.length > 0) {
      for (const offer of offers) {
        globalChecks.push({
          id: `offer_${offer.token.slice(0, 12)}`,
          category: "Offer",
          label: `${offer.token} (${offer.contract_type ?? "unknown"})`,
          status: offer.status === "completed" ? "ok"
            : offer.status === "signed" ? "warning"
            : offer.status === "viewed" ? "info"
            : offer.status === "draft" ? "info"
            : "warning",
          detail: `Status: ${offer.status} — ${offer.client_name} (${offer.client_email})${offer.bundled_pipelines?.length ? ` — Pipelines: ${offer.bundled_pipelines.join(", ")}` : ""}`,
        })
      }
    } else {
      globalChecks.push({
        id: "offer_none",
        category: "Offer",
        label: "Offers",
        status: allLeads.length > 0 ? "warning" : "info",
        detail: allLeads.length > 0 ? "Lead exists but no offer found" : "No offers (legacy or direct client)",
      })
    }

    // ── 3. Pending Activation ──
    for (const pa of pendingActivations) {
      const isActivated = pa.status === "activated" && pa.activated_at != null
      const isStuck = pa.status === "payment_confirmed" && pa.activated_at == null

      if (isActivated) {
        globalChecks.push({
          id: `pa_${pa.id.slice(0, 8)}`,
          category: "Activation",
          label: `${pa.offer_token}`,
          status: "ok",
          detail: `Activated on ${pa.activated_at!.split("T")[0]}`,
        })
      } else if (isStuck) {
        globalChecks.push({
          id: `pa_${pa.id.slice(0, 8)}`,
          category: "Activation",
          label: `${pa.offer_token} — STUCK`,
          status: "error",
          detail: `Payment confirmed on ${pa.payment_confirmed_at?.split("T")[0] ?? "?"} but activation never ran. activated_at = NULL, prepared_steps = ${JSON.stringify(pa.prepared_steps ?? [])}`,
          fix: {
            action: "run_activation",
            label: "Run activate-service now",
            params: { pending_activation_id: pa.id, contact_id: contactId },
            description: `Calls activate-service for pending activation "${pa.offer_token}". This will: create contact link (if needed), create account, create service deliveries, create portal user, mark invoice paid, send data form.`,
            impact: [
              "Will attempt to create account (if not exists)",
              "Will create service deliveries from offer's bundled_pipelines",
              "Will create portal user and send welcome email",
              "Will create or mark invoice as paid",
              "IMPORTANT: If contact email differs from lead email, a duplicate contact may be created — review before confirming",
            ],
            risk: "high",
          },
        })
      } else if (pa.status === "awaiting_payment") {
        globalChecks.push({
          id: `pa_${pa.id.slice(0, 8)}`,
          category: "Activation",
          label: `${pa.offer_token}`,
          status: "warning",
          detail: `Awaiting payment since ${pa.signed_at?.split("T")[0] ?? "?"}`,
        })
      } else {
        globalChecks.push({
          id: `pa_${pa.id.slice(0, 8)}`,
          category: "Activation",
          label: `${pa.offer_token}`,
          status: "info",
          detail: `Status: ${pa.status}`,
        })
      }
    }

    // ── 4. Payment records ──
    const paidPayments = payments.filter(p => p.status === "Paid")
    if (paidPayments.length > 0) {
      const total = paidPayments.reduce((s, p) => s + Number(p.amount), 0)
      globalChecks.push({
        id: "payments_ok",
        category: "Payments",
        label: "Payment records",
        status: "ok",
        detail: `${paidPayments.length} paid — total ${paidPayments[0]?.amount_currency ?? "USD"} ${total.toLocaleString()}`,
      })
    } else if (pendingActivations.some(pa => pa.payment_confirmed_at != null)) {
      const pa = pendingActivations.find(p => p.payment_confirmed_at != null)!
      globalChecks.push({
        id: "payments_missing",
        category: "Payments",
        label: "Payment records",
        status: "error",
        detail: `Activation confirmed payment (${pa.currency ?? "?"} ${pa.amount ?? "?"}) but no payment row in CRM`,
        fix: {
          action: "create_payment_record",
          label: `Record ${pa.currency === "EUR" ? "\u20AC" : "$"}${Number(pa.amount ?? 0).toLocaleString()} payment`,
          params: {
            contact_id: contactId,
            account_id: accountIds[0] ?? null,
            amount: pa.amount,
            currency: pa.currency ?? "EUR",
            payment_method: labelPaymentMethod(pa.payment_method),
            description: `Setup fee — ${pa.offer_token}`,
            paid_date: pa.payment_confirmed_at?.split("T")[0],
          },
          description: "Creates a payment record in the CRM payments table linked to this contact.",
          impact: [
            "New row in payments table, status = Paid",
            "Finance dashboard will show this payment",
            "Does NOT create a QB invoice (separate step)",
          ],
          risk: "safe",
        },
      })
    } else if (payments.length === 0) {
      globalChecks.push({
        id: "payments_none",
        category: "Payments",
        label: "Payment records",
        status: linkedAccounts.length > 0 ? "warning" : "info",
        detail: "No payment records found",
      })
    }

    // ── 5. Portal user ──
    if (authUser) {
      globalChecks.push({
        id: "portal_user",
        category: "Portal",
        label: "Auth user",
        status: "ok",
        detail: `Exists (${authUser.email})${authUser.last_sign_in_at ? ` — last login: ${authUser.last_sign_in_at.split("T")[0]}` : " — never logged in"}`,
      })
    } else if (contactEmail) {
      globalChecks.push({
        id: "portal_user",
        category: "Portal",
        label: "Auth user",
        status: linkedAccounts.length > 0 ? "warning" : "info",
        detail: "No portal auth user found",
        fix: linkedAccounts.length > 0 ? {
          action: "create_portal_user",
          label: "Create portal user",
          params: { contact_id: contactId },
          description: "Creates a Supabase auth user with a temporary password and sends welcome email.",
          impact: [
            "Auth user created with email " + contactEmail,
            "Temporary password generated",
            "Welcome email sent to client",
            "Portal tier set to 'active'",
          ],
          risk: "high",
        } : undefined,
      })
    } else {
      globalChecks.push({
        id: "portal_user",
        category: "Portal",
        label: "Auth user",
        status: "warning",
        detail: "No email on contact — cannot create portal user",
      })
    }

    // Portal tier consistency
    const portalTier = contact.portal_tier as string | null
    for (const acct of linkedAccounts) {
      if (acct.portal_tier && portalTier && acct.portal_tier !== portalTier) {
        globalChecks.push({
          id: `portal_tier_mismatch_${acct.id.slice(0, 8)}`,
          category: "Portal",
          label: `Tier mismatch: ${acct.company_name}`,
          status: "warning",
          detail: `Contact tier: ${portalTier}, Account tier: ${acct.portal_tier}`,
          fix: {
            action: "sync_portal_tier",
            label: "Sync to contact tier",
            params: { account_id: acct.id, tier: portalTier },
            description: `Sets account portal_tier to "${portalTier}" to match contact.`,
            impact: ["Account portal_tier updated", "Portal dashboard may show different features"],
            risk: "safe",
          },
        })
      }
    }

    // ── 6. Data collection forms ──
    for (const offer of offers) {
      if (offer.contract_type === "formation") {
        const hasSub = formationSubs.length > 0
        if (hasSub) {
          const sub = formationSubs[0]
          globalChecks.push({
            id: `form_formation_${sub.id.slice(0, 8)}`,
            category: "Data Forms",
            label: "Formation wizard",
            status: sub.status === "reviewed" ? "ok" : sub.status === "completed" ? "warning" : "info",
            detail: `Status: ${sub.status}${sub.completed_at ? ` — completed ${sub.completed_at.split("T")[0]}` : ""}`,
          })
        } else {
          globalChecks.push({
            id: `form_formation_missing_${offer.token.slice(0, 8)}`,
            category: "Data Forms",
            label: "Formation wizard",
            status: "warning",
            detail: "No formation submission found — client hasn't received or completed the data form",
            fix: {
              action: "create_formation_form",
              label: "Create & send formation form",
              params: {
                lead_id: allLeads[0]?.id ?? null,
                contact_id: contactId,
                language: contact.language ?? "Italian",
              },
              description: "Creates a formation data collection form and sends it to the client via email.",
              impact: [
                "Formation submission record created",
                "Email sent to client with form link",
                "Client can fill in LLC details, passport, etc.",
              ],
              risk: "moderate",
            },
          })
        }
      }

      if (offer.contract_type === "onboarding") {
        const hasSub = onboardingSubs.length > 0
        if (hasSub) {
          const sub = onboardingSubs[0]
          globalChecks.push({
            id: `form_onboarding_${sub.id.slice(0, 8)}`,
            category: "Data Forms",
            label: "Onboarding wizard",
            status: sub.status === "reviewed" ? "ok" : sub.status === "completed" ? "warning" : "info",
            detail: `Status: ${sub.status}${sub.completed_at ? ` — completed ${sub.completed_at.split("T")[0]}` : ""}`,
          })
        } else {
          globalChecks.push({
            id: `form_onboarding_missing_${offer.token.slice(0, 8)}`,
            category: "Data Forms",
            label: "Onboarding wizard",
            status: "warning",
            detail: "No onboarding submission found",
          })
        }
      }
    }

    // ── 7. Documents (contact-level) ──
    const passportDocs = docs.filter(d => d.document_type_name?.toLowerCase().includes("passport"))
    globalChecks.push({
      id: "docs_passport",
      category: "Documents",
      label: "Passport",
      status: contact.passport_on_file || passportDocs.length > 0 ? "ok" : "info",
      detail: contact.passport_on_file
        ? `On file${contact.passport_number ? ` (${contact.passport_number})` : ""}`
        : passportDocs.length > 0
          ? `${passportDocs.length} passport doc(s) but passport_on_file = false`
          : "No passport on file",
    })

    // ── 8. Contact profile completeness (merged from Contact Diagnose) ──
    const profileMissing: string[] = []
    if (!contact.date_of_birth) profileMissing.push("date of birth")
    if (!contact.citizenship) profileMissing.push("citizenship")
    if (!contact.phone) profileMissing.push("phone")
    globalChecks.push({
      id: "profile_completeness",
      category: "Contact Profile",
      label: "Profile completeness",
      status: profileMissing.length === 0 ? "ok" : profileMissing.length <= 1 ? "warning" : "error",
      detail: profileMissing.length === 0
        ? "All key fields present (DOB, citizenship, phone)"
        : `Missing: ${profileMissing.join(", ")}`,
    })

    // ── 9. Stuck service deliveries (>7 days unchanged) ──
    const now = new Date()
    const stuckSDs = services.filter(sd => {
      if (sd.status !== "active") return false
      if (!sd.updated_at) return false
      const daysSince = (now.getTime() - new Date(sd.updated_at).getTime()) / (1000 * 60 * 60 * 24)
      return daysSince > 7
    })
    if (stuckSDs.length > 0) {
      globalChecks.push({
        id: "stuck_services",
        category: "Services",
        label: "Stuck services",
        status: "warning",
        detail: `${stuckSDs.length} active service(s) unchanged for >7 days: ${stuckSDs.map(s => s.service_name || s.service_type).join(", ")}`,
      })
    }

    // ── 10. Portal login recency ──
    if (authUser) {
      if (!authUser.last_sign_in_at) {
        globalChecks.push({
          id: "portal_login",
          category: "Portal",
          label: "Portal login",
          status: "warning",
          detail: "Auth user exists but has never logged in",
        })
      } else {
        const daysSinceLogin = (now.getTime() - new Date(authUser.last_sign_in_at).getTime()) / (1000 * 60 * 60 * 24)
        if (daysSinceLogin > 30) {
          globalChecks.push({
            id: "portal_login",
            category: "Portal",
            label: "Portal login",
            status: "info",
            detail: `Last login ${Math.round(daysSinceLogin)} days ago (${authUser.last_sign_in_at.split("T")[0]})`,
          })
        }
      }
    }

    // ═══════════════════════════════════════
    // PER-ACCOUNT CHECKS
    // ═══════════════════════════════════════
    const accountAudits: AccountAudit[] = []

    for (const acct of linkedAccounts) {
      const acctChecks: ChainCheck[] = []
      const acctServices = services.filter(s => s.account_id === acct.id)
      const acctOA = oaAgreements.filter(o => o.account_id === acct.id)
      const acctLease = leaseAgreements.filter(l => l.account_id === acct.id)

      // ── Shared classification ──
      const formationSD = acctServices.find(s => s.service_type === "Company Formation" && s.status === "active")
        ?? acctServices.find(s => s.service_type === "Company Formation" && s.status === "completed")
      const formationStageOrder = formationSD?.stage_order ?? 0
      const formationStage = formationSD?.stage ?? null
      const acctSS4 = ss4Apps.filter(s => s.account_id === acct.id)
      const acctTR = taxReturns.find(t => t.account_id === acct.id)

      const classification = classifyAccount({
        accountId: acct.id,
        accountType: acct.account_type,
        accountStatus: acct.status,
        einNumber: acct.ein_number,
        formationDate: acct.formation_date,
        entityType: acct.entity_type,
        activeServiceTypes: acctServices.filter(s => s.status === "active").map(s => s.service_type).filter(Boolean),
        formationSD: formationSD ? { stage: formationSD.stage, stageOrder: formationSD.stage_order, status: formationSD.status } : null,
        taxReturn: acctTR ? { taxYear: acctTR.tax_year, extensionFiled: acctTR.extension_filed, status: acctTR.status, firstYearSkip: acctTR.first_year_skip } : null,
        ss4: acctSS4.length > 0 ? { status: acctSS4[0].status } : null,
      })

      // ── Classification summary (visible in audit results) ──
      acctChecks.push({
        id: `classification_${acct.id.slice(0, 8)}`,
        category: "Classification",
        label: `Category: ${classification.category}`,
        status: classification.category === "incomplete" ? "warning" : "ok",
        detail: [
          classification.formationComplete ? "Formation: complete" : classification.formationInProgress ? "Formation: in progress" : "Formation: not started",
          classification.isWaitingForEIN ? "EIN: pending" : acct.ein_number ? `EIN: ${acct.ein_number}` : "EIN: none",
          classification.taxReturnExpected ? `Tax: expected (${classification.taxReturnReason})` : `Tax: ${classification.taxReturnReason}`,
          ...classification.pendingReasons.map(p => `⏳ ${p.reason}`),
        ].join(" · "),
      })

      const hasEIN = !!acct.ein_number

      // Stage thresholds for Company Formation pipeline:
      const STAGE_EIN_APPLICATION = 3
      const STAGE_POST_FORMATION = 5

      // ── Pipeline position indicator ──
      if (formationSD) {
        // Check if the stage is BEHIND actual progress
        const hasFormationDate = !!acct.formation_date
        const stageBehind = hasFormationDate && formationStageOrder < STAGE_EIN_APPLICATION
        const hasEINButEarly = hasEIN && formationStageOrder < STAGE_POST_FORMATION

        if (stageBehind || hasEINButEarly) {
          // Stage is behind — formation date exists but SD hasn't been advanced
          const targetStage = hasEIN ? "Post-Formation + Banking" : "EIN Application"
          const targetStageNum = hasEIN ? 5 : 3
          const expectedLabel = `${targetStage} (Stage ${targetStageNum})`
          acctChecks.push({
            id: `pipeline_${acct.id.slice(0, 8)}`,
            category: "Formation Pipeline",
            label: `Stage ${formationStageOrder} of 6 — ${formationStage} ⚠️ BEHIND`,
            status: "error",
            detail: `${hasFormationDate ? `Articles received (${acct.formation_date})` : ""}${hasEIN ? `, EIN: ${acct.ein_number}` : ""} — but SD is still at Stage ${formationStageOrder}. Should be at ${expectedLabel}.`,
            fix: {
              action: "advance_to_stage",
              label: `Advance to ${targetStage}`,
              params: { delivery_id: formationSD!.id, target_stage: targetStage, account_id: acct.id },
              description: `Advances the Company Formation SD directly from "${formationStage}" to "${targetStage}" (skipping intermediate stages). This is safe because the earlier stages are already completed.`,
              impact: [
                `SD stage jumps from ${formationStageOrder} to ${targetStageNum}`,
                "Stage history updated with all skipped stages",
                "Auto-tasks created for the target stage",
              ],
              risk: "moderate",
            },
          })
        } else {
          acctChecks.push({
            id: `pipeline_${acct.id.slice(0, 8)}`,
            category: "Formation Pipeline",
            label: `Stage ${formationStageOrder} of 6 — ${formationStage}`,
            status: "info",
            detail: `Company Formation is in progress. Current stage determines which checks are relevant below.`,
          })
        }
      } else if (classification.formationComplete) {
        acctChecks.push({
          id: `pipeline_${acct.id.slice(0, 8)}`,
          category: "Formation Pipeline",
          label: "Formation complete",
          status: "ok",
          detail: "Company Formation pipeline is completed.",
        })
      }

      // ── Account type check (always relevant) ──
      const hasActiveSDs = acctServices.filter(s => s.status === "active").length > 0
      if (acct.account_type === "One-Time" && hasActiveSDs) {
        acctChecks.push({
          id: `acct_type_${acct.id.slice(0, 8)}`,
          category: "Account",
          label: "Account type",
          status: "error",
          detail: `Marked as "One-Time" but has ${acctServices.filter(s => s.status === "active").length} active service deliveries — should be "Client"`,
          fix: {
            action: "set_account_type",
            label: 'Change to "Client"',
            params: { account_id: acct.id, account_type: "Client" },
            description: 'Updates account_type from "One-Time" to "Client".',
            impact: ["Account type changes in CRM", "Will appear in regular client lists"],
            risk: "safe",
          },
        })
      } else {
        acctChecks.push({
          id: `acct_type_${acct.id.slice(0, 8)}`,
          category: "Account",
          label: "Account type",
          status: "ok",
          detail: `${acct.account_type ?? "not set"}${hasActiveSDs ? ` — ${acctServices.filter(s => s.status === "active").length} active SDs` : ""}`,
        })
      }

      // ── EIN check — uses classification to distinguish pending vs missing ──
      if (acct.entity_type?.includes("LLC") || acct.entity_type?.includes("Corp")) {
        if (hasEIN) {
          acctChecks.push({
            id: `ein_${acct.id.slice(0, 8)}`,
            category: "Account",
            label: "EIN",
            status: "ok",
            detail: acct.ein_number!,
          })
        } else if (classification.isWaitingForEIN) {
          // Classification says EIN is pending — show as info, not warning
          const einReason = classification.pendingReasons.find(p => p.field === "ein_number")
          acctChecks.push({
            id: `ein_${acct.id.slice(0, 8)}`,
            category: "Account",
            label: "EIN pending",
            status: "info",
            detail: einReason?.reason ?? "EIN not yet received — formation in progress",
          })
        } else if (classification.formationComplete) {
          // Formation is done but no EIN — this is a real problem
          const einReason = classification.pendingReasons.find(p => p.field === "ein_number")
          acctChecks.push({
            id: `ein_${acct.id.slice(0, 8)}`,
            category: "Account",
            label: "EIN",
            status: einReason ? "warning" : "error",
            detail: einReason?.reason ?? "Missing — formation complete but EIN not recorded",
          })
        } else if (classification.category === "new_formation") {
          // Early formation — EIN not expected yet, don't show check
        } else {
          acctChecks.push({
            id: `ein_${acct.id.slice(0, 8)}`,
            category: "Account",
            label: "EIN",
            status: "warning",
            detail: "Missing — needed for banking and tax filing",
          })
        }
      }

      // ── Service deliveries — uses classification for expected vs actual ──
      if (classification.category === "one_time") {
        // One-Time: no standard bundle expected
        acctChecks.push({
          id: `sds_onetime_${acct.id.slice(0, 8)}`,
          category: "Services",
          label: "Service deliveries",
          status: "ok",
          detail: `One-Time account — ${acctServices.filter(s => s.status === "active").length} active SD(s)`,
        })
      } else if (classification.category === "new_formation") {
        // Formation in progress — other SDs deferred
        acctChecks.push({
          id: `sds_formation_${acct.id.slice(0, 8)}`,
          category: "Services",
          label: "Service deliveries",
          status: "info",
          detail: `Formation in progress — standard SDs will be created after formation completes`,
        })
      } else if (classification.missingSDs.length > 0) {
        // Missing SDs — offer fix
        acctChecks.push({
          id: `sds_missing_${acct.id.slice(0, 8)}`,
          category: "Services",
          label: "Missing services",
          status: "error",
          detail: `Expected [${classification.expectedSDs.join(", ")}] but missing: ${classification.missingSDs.join(", ")}`,
          fix: {
            action: "create_missing_sds",
            label: `Create ${classification.missingSDs.length} missing SD(s)`,
            params: { account_id: acct.id, contact_id: contactId, pipelines: classification.missingSDs },
            description: `Creates service deliveries for: ${classification.missingSDs.join(", ")}. Each starts at Stage 1 with auto-tasks.`,
            impact: classification.missingSDs.map(m => `${m} SD created at first stage`),
            risk: "moderate",
          },
        })
      } else if (acctServices.length > 0) {
        acctChecks.push({
          id: `sds_ok_${acct.id.slice(0, 8)}`,
          category: "Services",
          label: "Service deliveries",
          status: "ok",
          detail: `${acctServices.filter(s => s.status === "active").length} active SD(s) — all expected services present`,
        })
      } else {
        acctChecks.push({
          id: `sds_none_${acct.id.slice(0, 8)}`,
          category: "Services",
          label: "Service deliveries",
          status: classification.category === "incomplete" ? "warning" : "info",
          detail: "No service deliveries for this account",
        })
      }

      // Tax return expectation (from classification)
      if (classification.taxReturnExpected && !classification.actualSDs.includes("Tax Return")) {
        acctChecks.push({
          id: `tax_expected_${acct.id.slice(0, 8)}`,
          category: "Services",
          label: "Tax Return expected",
          status: "warning",
          detail: classification.taxReturnReason,
        })
      } else if (!classification.taxReturnExpected && classification.taxReturnReason) {
        acctChecks.push({
          id: `tax_info_${acct.id.slice(0, 8)}`,
          category: "Services",
          label: "Tax Return",
          status: "info",
          detail: classification.taxReturnReason,
        })
      }

      // ── SS-4 / EIN pipeline — only relevant at stage 3+ (EIN Application) ──
      if (acct.entity_type?.includes("LLC") || acct.entity_type?.includes("Corp")) {
        if (acctSS4.length > 0) {
          const ss4 = acctSS4[0]
          acctChecks.push({
            id: `ss4_${acct.id.slice(0, 8)}`,
            category: "EIN Pipeline",
            label: "SS-4 Application",
            status: ss4.status === "done" ? "ok" : ss4.status === "submitted" ? "info" : "warning",
            detail: `Status: ${ss4.status}${ss4.ein_number ? ` — EIN: ${ss4.ein_number}` : ""}`,
          })
        } else if (!hasEIN) {
          // Only show SS-4 warning if formation is at EIN Application stage or later, or no formation SD
          if (!classification.formationInProgress || formationStageOrder >= STAGE_EIN_APPLICATION || classification.formationComplete) {
            acctChecks.push({
              id: `ss4_missing_${acct.id.slice(0, 8)}`,
              category: "EIN Pipeline",
              label: "SS-4 Application",
              status: "warning",
              detail: "No SS-4 application and no EIN — SS-4 needs to be created",
            })
          }
        }
      }

      // ── Portal transition — only for legacy clients OR post-formation (stage 5+) ──
      // For formation in progress (stages 1-4): portal transition is premature
      const isFormationEarlyStage = classification.formationInProgress && formationStageOrder < STAGE_POST_FORMATION
      if (!acct.portal_account && acct.status === "Active" && acct.account_type === "Client") {
        if (isFormationEarlyStage) {
          // Don't show portal transition for formation clients in early stages
          acctChecks.push({
            id: `portal_transition_${acct.id.slice(0, 8)}`,
            category: "Portal",
            label: "Portal setup",
            status: "info",
            detail: `Portal will be set up after formation is complete (currently at: ${formationStage})`,
          })
        } else {
          acctChecks.push({
            id: `portal_transition_${acct.id.slice(0, 8)}`,
            category: "Portal",
            label: "Portal transition needed",
            status: "warning",
            detail: `Active Client account without portal — run Portal Transition from the Account page (/accounts/${acct.id})`,
          })
        }
      } else if (acct.portal_account) {
        acctChecks.push({
          id: `portal_transition_${acct.id.slice(0, 8)}`,
          category: "Portal",
          label: "Portal status",
          status: "ok",
          detail: `Portal active — tier: ${acct.portal_tier ?? "not set"}`,
        })
      }

      // ── OA / Lease — only relevant at stage 5+ (Post-Formation) or for non-formation accounts ──
      if (acct.account_type === "Client" && acct.status === "Active" && !isFormationEarlyStage) {
        const signedOA = acctOA.find(o => o.status === "signed")
        acctChecks.push({
          id: `oa_${acct.id.slice(0, 8)}`,
          category: "Agreements",
          label: "Operating Agreement",
          status: signedOA ? "ok" : acctOA.length > 0 ? "info" : "warning",
          detail: signedOA
            ? `Signed${signedOA.signed_at ? ` on ${signedOA.signed_at.split("T")[0]}` : ""}`
            : acctOA.length > 0
              ? `${acctOA.length} OA(s) — latest: ${acctOA[0].status}`
              : "No OA found",
        })

        const signedLease = acctLease.find(l => l.status === "signed")
        acctChecks.push({
          id: `lease_${acct.id.slice(0, 8)}`,
          category: "Agreements",
          label: "Lease Agreement",
          status: signedLease ? "ok" : acctLease.length > 0 ? "info" : "warning",
          detail: signedLease
            ? `Signed${signedLease.signed_at ? ` on ${signedLease.signed_at.split("T")[0]}` : ""}`
            : acctLease.length > 0
              ? `${acctLease.length} lease(s) — latest: ${acctLease[0].status}`
              : "No lease found",
        })
      }

      accountAudits.push({
        account_id: acct.id,
        company_name: acct.company_name,
        entity_type: acct.entity_type,
        status: acct.status,
        account_type: acct.account_type,
        role: acct.role,
        checks: acctChecks,
      })
    }

    // ── Check for offers WITHOUT an account (Mocellin pattern) ──
    // These are offers tied to a lead but no account was ever created
    for (const offer of offers) {
      const hasMatchingAccount = linkedAccounts.some(a => a.id === offer.account_id)
      const pa = pendingActivations.find(p => p.offer_token === offer.token)
      const isStuck = pa && pa.status === "payment_confirmed" && pa.activated_at == null

      if (!hasMatchingAccount && !offer.account_id && offer.status !== "draft" && offer.status !== "viewed") {
        // Check if any service deliveries exist for this offer
        const offerSDs = services.filter(s => s.notes?.includes(offer.token))

        globalChecks.push({
          id: `orphan_offer_${offer.token.slice(0, 12)}`,
          category: "Missing Account",
          label: `${offer.client_name} — no account`,
          status: "error",
          detail: `Offer "${offer.token}" (${offer.contract_type}, ${offer.status}) has no linked account. ${isStuck ? "Activation is STUCK." : ""} ${offerSDs.length > 0 ? `${offerSDs.length} SDs exist.` : "No SDs created."}`,
          fix: {
            action: "create_account_for_offer",
            label: "Create account + link",
            params: {
              contact_id: contactId,
              offer_token: offer.token,
              client_name: offer.client_name,
              contract_type: offer.contract_type,
              lead_id: offer.lead_id,
            },
            description: `Creates a new account for "${offer.client_name}" and links it to this contact. You'll be prompted for company name, entity type, and state.`,
            impact: [
              "New account row created in CRM",
              "Contact linked as Owner via account_contacts",
              "Offer updated with account_id",
              "If pending activation is stuck, you can then run activation",
            ],
            risk: "moderate",
          },
        })
      }
    }

    // ── No accounts at all ──
    if (linkedAccounts.length === 0) {
      globalChecks.push({
        id: "no_accounts",
        category: "Missing Account",
        label: "No linked accounts",
        status: offers.length > 0 || allLeads.length > 0 ? "error" : "info",
        detail: offers.length > 0
          ? "Contact has offers but no account — activation may not have run"
          : allLeads.length > 0
            ? "Lead exists but no account created yet"
            : "No accounts (may be individual services only)",
      })
    }

    // ── Combine all checks for summary ──
    const allChecks = [...globalChecks, ...accountAudits.flatMap(a => a.checks)]
    const summary = summarize(allChecks)

    const result: ChainAuditResult = {
      contact: {
        id: contact.id as string,
        full_name: contact.full_name as string,
        email: contactEmail,
        portal_tier: contact.portal_tier as string | null,
      },
      global_checks: globalChecks,
      account_audits: accountAudits,
      summary,
    }

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ─── POST: Execute Fix ───

export async function POST(req: NextRequest) {
  try {
    const { contact_id, action, params } = await req.json()
    if (!contact_id || !action) {
      return NextResponse.json({ error: "Missing contact_id or action" }, { status: 400 })
    }

    switch (action) {
      case "link_lead_to_contact": {
        const { lead_id } = params as { lead_id: string; contact_id: string }
        const { error } = await supabaseAdmin
          .from("leads")
          .update({
            converted_to_contact_id: contact_id,
            status: "Converted",
            converted_at: new Date().toISOString(),
          })
          .eq("id", lead_id)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({
          success: true,
          detail: "Lead linked to contact and set to Converted",
          side_effects: ["leads.converted_to_contact_id updated", "leads.status = Converted", "leads.converted_at = today"],
        })
      }

      case "set_account_type": {
        const { account_id, account_type } = params as { account_id: string; account_type: string }
        // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
        const { error } = await supabaseAdmin
          .from("accounts")
          .update({ account_type, updated_at: new Date().toISOString() })
          .eq("id", account_id)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({
          success: true,
          detail: `Account type updated to "${account_type}"`,
          side_effects: [`accounts.account_type = ${account_type}`],
        })
      }

      case "create_payment_record": {
        const { amount, currency, payment_method, description, paid_date } = params as {
          contact_id: string; account_id: string | null
          amount: number; currency: string; payment_method: string
          description: string; paid_date?: string
        }
        const effectivePaidDate = paid_date ?? new Date().toISOString().split("T")[0]
        try {
          const { createTDInvoice } = await import("@/lib/portal/td-invoice")
          const result = await createTDInvoice({
            contact_id,
            account_id: params.account_id ?? undefined,
            line_items: [{
              description: description ?? "Setup fee",
              unit_price: amount,
              quantity: 1,
            }],
            currency: currency as "USD" | "EUR",
            mark_as_paid: true,
            paid_date: effectivePaidDate,
            payment_method: payment_method ?? "Wire Transfer",
          })
          // Preserve the legacy `period: "One-Time"` field that createTDInvoice doesn't set.
          // eslint-disable-next-line no-restricted-syntax -- targeted post-create field update for legacy compat
          await supabaseAdmin
            .from("payments")
            .update({ period: "One-Time", invoice_date: effectivePaidDate })
            .eq("id", result.paymentId)
          return NextResponse.json({
            success: true,
            detail: `Payment recorded: ${currency} ${amount} as Paid (invoice ${result.invoiceNumber})`,
            side_effects: ["New row in payments table", `Invoice ${result.invoiceNumber}`, "Status: Paid"],
          })
        } catch (e) {
          return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
        }
      }

      case "create_portal_user": {
        // Delegate to the existing portal creation endpoint
        const resp = await fetch(`${INTERNAL_BASE_URL}/api/crm/admin-actions/contact-portal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id, action: "create_portal" }),
        })
        const result = await resp.json()
        if (!resp.ok) return NextResponse.json({ error: result.error || "Portal creation failed" }, { status: resp.status })
        return NextResponse.json(result)
      }

      case "sync_portal_tier": {
        const { account_id, tier } = params as { account_id: string; tier: string }
        // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/portal.ts
        const { error } = await supabaseAdmin
          .from("accounts")
          .update({ portal_tier: tier, updated_at: new Date().toISOString() })
          .eq("id", account_id)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({
          success: true,
          detail: `Account portal_tier synced to "${tier}"`,
          side_effects: [`accounts.portal_tier = ${tier}`],
        })
      }

      case "run_activation": {
        const { pending_activation_id } = params as { pending_activation_id: string; contact_id: string }
        const apiUrl = `${INTERNAL_BASE_URL}/api/workflows/activate-service`
        const resp = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
          },
          body: JSON.stringify({ pending_activation_id }),
        })
        const result = await resp.json()
        if (!resp.ok) return NextResponse.json({ error: result.error || "Activation failed" }, { status: resp.status })
        return NextResponse.json({
          success: true,
          detail: "activate-service executed",
          side_effects: ["Check CRM for new account, SDs, portal user, invoice"],
          result,
        })
      }

      case "create_account_for_offer": {
        const { offer_token, lead_id } = params as {
          contact_id: string; offer_token: string; client_name: string
          contract_type: string | null; lead_id: string | null
        }

        // Use form-provided values (from UI) — these come from the Articles of Organization
        const companyName = (params.company_name as string)?.trim()
        const entityType = (params.entity_type as string) || "Single Member LLC"
        const stateOfFormation = (params.state_of_formation as string) || null
        const formationDate = (params.formation_date as string) || null

        if (!companyName) {
          return NextResponse.json({ error: "Company name is required" }, { status: 400 })
        }

        // Determine status based on whether formation date is provided
        // If we have a formation date → Articles received → Active
        // If no formation date → still in formation → Pending Formation
        const accountStatus = formationDate ? "Active" : "Pending Formation"

        // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
        const { data: newAccount, error: acctErr } = await supabaseAdmin
          .from("accounts")
          .insert({
            company_name: companyName,
            entity_type: entityType as never,
            state_of_formation: stateOfFormation,
            formation_date: formationDate,
            status: accountStatus,
            account_type: "Client",
            portal_account: false,
            notes: `Created from chain audit. Offer: ${offer_token}. Articles of Organization received.`,
          })
          .select("id, company_name")
          .single()

        if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 })

        // Link contact
        await supabaseAdmin.from("account_contacts").insert({
          account_id: newAccount.id,
          contact_id,
          role: "Owner",
        })

        // Update offer with account_id
        await supabaseAdmin.from("offers").update({ account_id: newAccount.id }).eq("token", offer_token)

        // Update lead if exists
        if (lead_id) {
          await supabaseAdmin.from("leads").update({ converted_to_account_id: newAccount.id }).eq("id", lead_id)
        }

        return NextResponse.json({
          success: true,
          detail: `Account "${newAccount.company_name}" created (${newAccount.id})`,
          side_effects: [
            `New account: ${newAccount.company_name}`,
            "Contact linked as Owner",
            "Offer updated with account_id",
            lead_id ? "Lead updated with converted_to_account_id" : null,
            "REVIEW: Check company name and entity type (may need to be Multi Member LLC)",
          ].filter(Boolean),
          account_id: newAccount.id,
        })
      }

      case "advance_to_stage": {
        const { delivery_id, target_stage } = params as { delivery_id: string; target_stage: string; account_id: string }

        // Get current delivery
        const { data: delivery, error: dErr } = await supabaseAdmin
          .from("service_deliveries")
          .select("*")
          .eq("id", delivery_id)
          .single()
        if (dErr || !delivery) return NextResponse.json({ error: "Service delivery not found" }, { status: 404 })

        // Get pipeline stages
        const { data: pStages } = await supabaseAdmin
          .from("pipeline_stages")
          .select("*")
          .eq("service_type", delivery.service_type)
          .order("stage_order")
        if (!pStages?.length) return NextResponse.json({ error: "No pipeline stages found" }, { status: 500 })

        // Find target stage
        const target = pStages.find((s: { stage_name: string }) => s.stage_name.toLowerCase() === target_stage.toLowerCase())
        if (!target) return NextResponse.json({ error: `Stage "${target_stage}" not found in pipeline` }, { status: 400 })

        // Build stage history with all skipped stages
        const currentOrder = delivery.stage_order || 0
        const history = [...((delivery.stage_history as Array<Record<string, unknown>>) || [])]
        // Add current stage to history
        history.push({ stage: delivery.stage, stage_order: currentOrder, entered_at: delivery.stage_entered_at, exited_at: new Date().toISOString(), notes: "Skipped — caught up via chain audit" })
        // Add intermediate skipped stages
        for (const s of pStages) {
          if (s.stage_order > currentOrder && s.stage_order < target.stage_order) {
            history.push({ stage: s.stage_name, stage_order: s.stage_order, entered_at: new Date().toISOString(), exited_at: new Date().toISOString(), notes: "Skipped — already completed" })
          }
        }

        // Update SD to target stage
        // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/service-delivery.ts
        const { error: updateErr } = await supabaseAdmin
          .from("service_deliveries")
          .update({
            stage: target.stage_name,
            stage_order: target.stage_order,
            stage_entered_at: new Date().toISOString(),
            stage_history: history as unknown as Json,
            updated_at: new Date().toISOString(),
          })
          .eq("id", delivery_id)
        if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

        return NextResponse.json({
          success: true,
          detail: `Advanced from "${delivery.stage}" to "${target.stage_name}" (Stage ${currentOrder} → ${target.stage_order})`,
          side_effects: [
            `SD stage: ${delivery.stage} → ${target.stage_name}`,
            `Skipped ${target.stage_order - currentOrder - 1} intermediate stage(s)`,
            "Stage history updated",
          ],
        })
      }

      case "create_missing_sds": {
        const { account_id, pipelines } = params as {
          account_id: string; contact_id: string; pipelines: string[]
        }

        // Load account name once (used for all non-ITIN pipelines)
        const { data: acct } = await supabaseAdmin
          .from("accounts")
          .select("company_name")
          .eq("id", account_id)
          .single()

        // Load contact name for ITIN (personal document — must use person name, not company)
        let contactFullName: string | null = null
        if (pipelines.includes("ITIN") && contact_id) {
          const { data: ct } = await supabaseAdmin
            .from("contacts")
            .select("full_name")
            .eq("id", contact_id)
            .single()
          contactFullName = ct?.full_name ?? null
        }

        const created: string[] = []
        for (const pipeline of pipelines) {
          // ITIN is a personal document — use the contact's name, not the company name
          const displayName = pipeline === "ITIN"
            ? `ITIN — ${contactFullName ?? acct?.company_name ?? "Unknown"}`
            : `${pipeline} — ${acct?.company_name ?? "Unknown"}`

          // Tax Return: intake stages (stage_order < 1) are only for the
          // business activation path. Chain audit always starts at "1st
          // Installment Paid". For all other service types, createSD
          // defaults to the lowest stage_order in pipeline_stages.
          const createParams =
            pipeline === "Tax Return"
              ? {
                  service_type: pipeline,
                  service_name: displayName,
                  account_id,
                  contact_id,
                  target_stage: "1st Installment Paid",
                  notes: "Created from chain audit fix",
                }
              : {
                  service_type: pipeline,
                  service_name: displayName,
                  account_id,
                  contact_id,
                  notes: "Created from chain audit fix",
                }

          try {
            await createSD(createParams)
            created.push(pipeline)
          } catch {
            // Swallow per pipeline — caller aggregates created count
          }
        }

        return NextResponse.json({
          success: true,
          detail: `Created ${created.length} service deliveries: ${created.join(", ")}`,
          side_effects: created.map(p => `${p} SD created at first stage`),
        })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
