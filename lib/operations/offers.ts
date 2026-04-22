/**
 * P3.4 #6 — Offer operation authority layer
 *
 * Single-entry offer-create path used by:
 *   - MCP offer_create tool (lib/mcp/tools/offers.ts)
 *   - CRM admin-actions/create-offer route (app/api/crm/admin-actions/create-offer/route.ts)
 *
 * Prior to extraction both paths duplicated the insert logic with drift —
 * the MCP variant auto-filled referrer from lead, the CRM variant
 * auto-generated tokens + ran the Whop checkout plan, and their duplicate
 * checks differed. This function is the union: callers pick which behaviors
 * apply via flags (auto_fill_referrer_from_lead, create_whop_plan, token).
 *
 * Publish/send is already consolidated in lib/offers/publish.ts — not
 * duplicated here.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { APP_BASE_URL } from "@/lib/config"
import { getBankDetailsByPreference, type BankPreference } from "@/app/offer/[token]/contract/bank-defaults"
import type { Json } from "@/lib/database.types"

// ─── JSONB validation ───────────────────────────────────────

function validateIssues(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.title || !item.description) return `issues[${i}] must have {title, description}`
  }
  return null
}

function validateStrategy(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (item.step_number == null || !item.title || !item.description) {
      return `strategy[${i}] must have {step_number, title, description}`
    }
  }
  return null
}

function validateServices(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.name || !item.price) return `services[${i}] must have {name, price}`
  }
  return null
}

function validateCostSummary(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.label) return `cost_summary[${i}] must have {label}`
  }
  return null
}

function validateRecurringCosts(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.label || !item.price) return `recurring_costs[${i}] must have {label, price}`
  }
  return null
}

function validateFutureDevelopments(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.text) return `future_developments[${i}] must have {text}`
  }
  return null
}

function validateNextSteps(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (item.step_number == null || !item.title || !item.description) {
      return `next_steps[${i}] must have {step_number, title, description}`
    }
  }
  return null
}

function validateImmediateActions(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.title) return `immediate_actions[${i}] must have {title}`
  }
  return null
}

/** Validate all JSONB fields, return first error or null. */
export function validateOfferJsonb(params: Record<string, unknown>): string | null {
  const validators: [string, (items: unknown[]) => string | null][] = [
    ["issues", validateIssues],
    ["strategy", validateStrategy],
    ["services", validateServices],
    ["additional_services", validateServices],
    ["cost_summary", validateCostSummary],
    ["recurring_costs", validateRecurringCosts],
    ["future_developments", validateFutureDevelopments],
    ["next_steps", validateNextSteps],
    ["immediate_actions", validateImmediateActions],
  ]
  for (const [field, validator] of validators) {
    const value = params[field]
    if (value && Array.isArray(value) && value.length > 0) {
      const err = validator(value)
      if (err) return err
    }
  }
  return null
}

// ─── Types ────────────────────────────────────────────────────

export type OfferContractType = "formation" | "onboarding" | "tax_return" | "itin" | "renewal"
export type OfferPaymentType = "checkout" | "bank_transfer" | "none" | "both"
export type OfferPaymentGateway = "whop" | "stripe"
export type OfferLanguage = "en" | "it"

export interface CreateOfferParams {
  client_name: string
  client_email?: string | null
  language: OfferLanguage

  // Linkage
  lead_id?: string | null
  account_id?: string | null
  deal_id?: string | null

  // Token (auto-generated if omitted)
  token?: string
  offer_date?: string

  // Contract structure
  contract_type?: OfferContractType
  payment_type: OfferPaymentType
  payment_gateway?: OfferPaymentGateway
  bank_preference?: BankPreference
  currency?: "EUR" | "USD"
  // Entity type (single-member / multi-member / corporation). Accepts short
  // codes (SMLLC/MMLLC/Corp) or the full DB enum values — normalized before
  // insert. Nullable — older offer flows that don't know the entity type
  // leave it NULL and consumers fall back to legacy derivation.
  entity_type?: "SMLLC" | "MMLLC" | "Corp" | "Single Member LLC" | "Multi Member LLC" | "C-Corp Elected" | null

  // Content (JSONB fields)
  services: unknown
  cost_summary: unknown
  recurring_costs?: unknown
  additional_services?: unknown
  issues?: unknown
  immediate_actions?: unknown
  strategy?: unknown
  next_steps?: unknown
  future_developments?: unknown
  intro_en?: string | null
  intro_it?: string | null
  admin_notes?: string | null
  required_documents?: unknown
  installment_currency?: string | null
  bundled_pipelines?: string[]

  payment_links?: unknown
  bank_details?: unknown
  effective_date?: string | null
  expires_at?: string | null

  // Referrer
  referrer_name?: string | null
  referrer_email?: string | null
  referrer_type?: "client" | "partner" | null
  referrer_account_id?: string | null
  referrer_commission_type?: "percentage" | "price_difference" | "credit_note" | null
  referrer_commission_pct?: number | null
  referrer_agreed_price?: number | null
  referrer_notes?: string | null

  // Control flags
  auto_fill_referrer_from_lead?: boolean // default true
  create_whop_plan?: boolean // default true when gateway=whop+checkout
  source?: string // 'crm-button' | 'mcp-claude' — goes into action_log
  actor?: string
}

export interface CreateOfferResult {
  success: boolean
  outcome: "created" | "duplicate_blocked" | "validation_error" | "not_found" | "error"
  token?: string
  access_code?: string | null
  status?: string
  offer_url?: string
  whop_checkout_url?: string | null
  referrer_auto_filled?: boolean
  duplicate?: { token: string; status: string }
  error?: string
}

// ─── Helpers ──────────────────────────────────────────────────

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join("-")
}

async function generateUniqueToken(clientName: string): Promise<string> {
  const base = `${slugifyName(clientName)}-${new Date().getFullYear()}`
  const { data: existing } = await supabaseAdmin
    .from("offers")
    .select("token")
    .eq("token", base)
    .maybeSingle()
  if (!existing) return base
  return `${base}-${Date.now().toString(36).slice(-4)}`
}

/**
 * Normalize entity_type input to the canonical company_type enum values
 * stored on offers.entity_type + accounts.entity_type. Accepts short codes
 * (SMLLC/MMLLC/Corp) from MCP callers or full enum values from internal code.
 * Returns null for anything unrecognized so the DB leaves the column NULL.
 */
function normalizeEntityType(
  v: string | null | undefined
): "Single Member LLC" | "Multi Member LLC" | "C-Corp Elected" | null {
  if (!v) return null
  const t = String(v).trim().toUpperCase()
  if (t === "SMLLC" || t === "SINGLE MEMBER LLC") return "Single Member LLC"
  if (t === "MMLLC" || t === "MULTI MEMBER LLC") return "Multi Member LLC"
  if (t === "CORP" || t === "C-CORP" || t === "C-CORP ELECTED") return "C-Corp Elected"
  return null
}

function detectCurrency(
  explicit: "EUR" | "USD" | undefined,
  cost_summary: unknown,
  services: unknown
): "EUR" | "USD" {
  if (explicit === "EUR" || explicit === "USD") return explicit
  const costArr = Array.isArray(cost_summary) ? cost_summary : []
  const firstTotal = (costArr[0] as Record<string, unknown>)?.total as string || ""
  const servicesStr = JSON.stringify(services || [])
  const eurHit = /€|EUR/i.test(firstTotal) || /€|EUR/i.test(servicesStr)
  return eurHit ? "EUR" : "USD"
}

async function tryCreateWhopPlan(params: {
  client_name: string
  currency: "EUR" | "USD"
  contract_type: string
  services: unknown
  cost_summary: unknown
  token: string
}): Promise<string | null> {
  try {
    const { createWhopPlan } = await import("@/lib/whop-auto-plan")
    const costArr = Array.isArray(params.cost_summary) ? params.cost_summary : []
    const firstTotal = (costArr[0] as Record<string, unknown>)?.total as string || ""
    const totalNum = parseFloat(firstTotal.replace(/[^0-9.]/g, ""))
    if (!(totalNum > 0)) return null
    const servArr = Array.isArray(params.services) ? params.services : []
    const primaryService = (servArr[0] as Record<string, unknown>)?.name as string | undefined
    const result = await createWhopPlan({
      clientName: params.client_name,
      amount: totalNum,
      currency: params.currency === "EUR" ? "eur" : "usd",
      contractType: params.contract_type,
      serviceName: primaryService,
    })
    if (result.success && result.checkoutUrl) {
      const cardAmount = Math.round(totalNum * 1.05)
      await supabaseAdmin
        .from("offers")
        .update({
          payment_links: [{
            url: result.checkoutUrl,
            label: `Pay ${params.currency === "EUR" ? "€" : "$"}${totalNum.toLocaleString()} by Card`,
            amount: cardAmount,
            gateway: "whop",
          }] as unknown as Json,
        })
        .eq("token", params.token)
      return result.checkoutUrl
    }
  } catch {
    // Whop failures are non-blocking — offer still created, just no card link
  }
  return null
}

// ─── Main ──────────────────────────────────────────────────────

export async function createOffer(params: CreateOfferParams): Promise<CreateOfferResult> {
  try {
    // 1. Validate JSONB fields
    const validationError = validateOfferJsonb(params as unknown as Record<string, unknown>)
    if (validationError) {
      return { success: false, outcome: "validation_error", error: validationError }
    }

    // 2. Require at least one of: client_name, and (lead_id OR account_id OR standalone allowed by MCP)
    if (!params.client_name) {
      return { success: false, outcome: "validation_error", error: "client_name is required" }
    }
    if (!params.services || !params.cost_summary) {
      return { success: false, outcome: "validation_error", error: "services and cost_summary are required" }
    }

    // 3. Validate lead/account existence (when provided)
    if (params.lead_id) {
      const { data: lead, error: leadErr } = await supabaseAdmin
        .from("leads")
        .select("id, referrer_name, referrer_partner_id")
        .eq("id", params.lead_id)
        .maybeSingle()
      if (leadErr || !lead) {
        return { success: false, outcome: "not_found", error: `Lead not found: ${params.lead_id}` }
      }
    }
    if (params.account_id) {
      const { data: acct, error: acctErr } = await supabaseAdmin
        .from("accounts")
        .select("id")
        .eq("id", params.account_id)
        .maybeSingle()
      if (acctErr || !acct) {
        return { success: false, outcome: "not_found", error: `Account not found: ${params.account_id}` }
      }
    }

    // 4. Duplicate check — block active offers (not expired/completed)
    if (params.lead_id || params.account_id) {
      const dupQuery = supabaseAdmin
        .from("offers")
        .select("token, status")
        .not("status", "in", '("expired","completed")')
        .limit(1)
      if (params.lead_id) dupQuery.eq("lead_id", params.lead_id)
      else if (params.account_id) dupQuery.eq("account_id", params.account_id)
      const { data: existing } = await dupQuery.maybeSingle()
      if (existing) {
        return {
          success: false,
          outcome: "duplicate_blocked",
          duplicate: { token: existing.token, status: existing.status || "" },
          error: `Active offer already exists: ${existing.token} (status: ${existing.status})`,
        }
      }
    }

    // 5. Token — use provided, else auto-generate
    const token = params.token || await generateUniqueToken(params.client_name)

    // 6. Auto-fill referrer from lead (default on)
    let refName = params.referrer_name ?? null
    const refEmail = params.referrer_email ?? null
    let refType = params.referrer_type ?? null
    let refAccountId = params.referrer_account_id ?? null
    let refCommissionType = params.referrer_commission_type ?? null
    let refCommissionPct = params.referrer_commission_pct ?? null
    let referralAutoFilled = false

    const autoFill = params.auto_fill_referrer_from_lead !== false
    if (autoFill && params.lead_id && !params.referrer_name) {
      const { data: lead } = await supabaseAdmin
        .from("leads")
        .select("referrer_name, referrer_partner_id")
        .eq("id", params.lead_id)
        .maybeSingle()
      if (lead?.referrer_name) {
        refName = lead.referrer_name
        referralAutoFilled = true
        if (lead.referrer_partner_id) {
          refType = "partner"
          refAccountId = lead.referrer_partner_id
        } else {
          refType = "client"
          refCommissionType = refCommissionType ?? "credit_note"
          refCommissionPct = refCommissionPct ?? 10
        }
      }
    }

    // 7. Currency + bank details
    const currency = detectCurrency(params.currency, params.cost_summary, params.services)
    const bank_details = params.bank_details
      || getBankDetailsByPreference((params.bank_preference || "auto") as BankPreference, currency)

    // 8. Insert offer
    const { data: offer, error: offerErr } = await supabaseAdmin
      .from("offers")
      .insert({
        token,
        client_name: params.client_name,
        client_email: params.client_email || null,
        language: params.language,
        offer_date: params.offer_date || new Date().toISOString().split("T")[0],
        status: "draft",
        payment_type: params.payment_type,
        contract_type: params.contract_type || "formation",
        services: params.services as Json,
        cost_summary: params.cost_summary as Json,
        recurring_costs: (params.recurring_costs ?? null) as Json,
        additional_services: (params.additional_services ?? null) as Json,
        issues: (params.issues ?? null) as Json,
        immediate_actions: (params.immediate_actions ?? null) as Json,
        strategy: (params.strategy ?? null) as Json,
        next_steps: (params.next_steps ?? null) as Json,
        future_developments: (params.future_developments ?? null) as Json,
        intro_en: params.intro_en ?? null,
        intro_it: params.intro_it ?? null,
        admin_notes: params.admin_notes ?? null,
        required_documents: (params.required_documents ?? null) as Json,
        installment_currency: params.installment_currency ?? null,
        bundled_pipelines: params.bundled_pipelines ?? [],
        entity_type: normalizeEntityType(params.entity_type),
        bank_details: bank_details as unknown as Json,
        payment_links: (params.payment_links ?? null) as Json,
        effective_date: params.effective_date ?? null,
        expires_at: params.expires_at ?? null,
        currency,
        lead_id: params.lead_id ?? null,
        account_id: params.account_id ?? null,
        deal_id: params.deal_id ?? null,
        referrer_name: refName,
        referrer_email: refEmail,
        referrer_type: refType,
        referrer_account_id: refAccountId,
        referrer_commission_type: refCommissionType,
        referrer_commission_pct: refCommissionPct,
        referrer_agreed_price: params.referrer_agreed_price ?? null,
        referrer_notes: params.referrer_notes ?? null,
        view_count: 0,
      })
      .select("token, access_code, status")
      .single()

    if (offerErr || !offer) {
      return {
        success: false,
        outcome: "error",
        error: offerErr?.message || "Unknown insert error",
      }
    }

    const accessCode = offer.access_code ?? ""
    const offer_url = `${APP_BASE_URL}/offer/${offer.token}/${accessCode}`

    // 9. Update lead with offer link if linked to a lead
    if (params.lead_id) {
      await supabaseAdmin
        .from("leads")
        .update({ offer_link: offer_url, offer_status: "Draft" })
        .eq("id", params.lead_id)
    }

    // 10. Whop auto-plan (default on when payment_gateway=whop + payment_type=checkout)
    let whopUrl: string | null = null
    const whopEnabled = params.create_whop_plan !== false
    if (whopEnabled && params.payment_type === "checkout" && params.payment_gateway === "whop") {
      whopUrl = await tryCreateWhopPlan({
        client_name: params.client_name,
        currency,
        contract_type: params.contract_type || "formation",
        services: params.services,
        cost_summary: params.cost_summary,
        token: offer.token,
      })
    }

    // 11. action_log
    logAction({
      actor: params.actor || (params.source === "mcp-claude" ? "claude.ai" : "crm-admin"),
      action_type: "create",
      table_name: "offers",
      record_id: offer.token,
      summary: `Offer created: ${params.client_name} (${offer.token})${refName ? ` — referral: ${refName}` : ""}`,
      details: {
        lead_id: params.lead_id,
        account_id: params.account_id,
        contract_type: params.contract_type,
        entity_type: normalizeEntityType(params.entity_type),
        payment_type: params.payment_type,
        payment_gateway: params.payment_gateway,
        bank_preference: params.bank_preference,
        bundled_pipelines: params.bundled_pipelines,
        required_documents: params.required_documents,
        source: params.source || "mcp-claude",
        referrer_auto_filled: referralAutoFilled,
      },
    })

    return {
      success: true,
      outcome: "created",
      token: offer.token,
      access_code: accessCode,
      status: offer.status || "draft",
      offer_url,
      whop_checkout_url: whopUrl,
      referrer_auto_filled: referralAutoFilled,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
