/**
 * Offer Tools — Manage client offers/proposals in Supabase
 *
 * Offers are stored in the `offers` table (columns in English).
 * Live at: offerte.tonydurante.us/?t={token}&c={access_code}
 * Contract signing at: offerte.tonydurante.us/offer/{token}/contract
 *
 * Workflow: create (draft) → review → send (Gmail draft) → client views → signs → pays
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"
import { logAction } from "@/lib/mcp/action-log"

// ─── JSONB Validation Helpers ───────────────────────────────

function validateIssues(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.title || !item.description) {
      return `issues[${i}] must have {title, description}`
    }
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
    if (!item.name || !item.price) {
      return `services[${i}] must have {name, price} (description, price_label, includes, recommended optional)`
    }
  }
  return null
}

function validateCostSummary(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.label) {
      return `cost_summary[${i}] must have {label} (items, total, total_label, rate optional)`
    }
  }
  return null
}

function validateRecurringCosts(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.label || !item.price) {
      return `recurring_costs[${i}] must have {label, price}`
    }
  }
  return null
}

function validateFutureDevelopments(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.text) {
      return `future_developments[${i}] must have {text}`
    }
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
    if (!item.title) {
      return `immediate_actions[${i}] must have {title} (text or description optional)`
    }
  }
  return null
}

/** Validate all JSONB fields, return first error or null */
function validateOfferJsonb(params: Record<string, unknown>): string | null {
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
      const error = validator(value)
      if (error) return error
    }
  }
  return null
}

// ─── Gmail Draft Helper ─────────────────────────────────────

async function createOfferDraft(
  clientEmail: string,
  clientName: string,
  token: string,
  accessCode: string,
  language: string,
) {
  const offerUrl = `https://offerte.tonydurante.us/?t=${encodeURIComponent(token)}&c=${accessCode}`

  const subject = language === "en"
    ? `Your Proposal from Tony Durante LLC`
    : `La Tua Proposta da Tony Durante LLC`

  const body = language === "en"
    ? `Dear ${clientName},\n\nThank you for your time during our consultation.\n\nPlease find your personalized proposal at the following link:\n${offerUrl}\n\nTo view the proposal, you will be asked to verify your email address.\n\nIf you have any questions, please don't hesitate to reach out.\n\nBest regards,\nTony Durante LLC\nsupport@tonydurante.us`
    : `Gentile ${clientName},\n\nGrazie per il tempo dedicato durante la nostra consulenza.\n\nPuoi consultare la tua proposta personalizzata al seguente link:\n${offerUrl}\n\nPer visualizzare la proposta, ti verrà chiesto di verificare il tuo indirizzo email.\n\nPer qualsiasi domanda, non esitare a contattarci.\n\nCordiali saluti,\nTony Durante LLC\nsupport@tonydurante.us`

  const headers = [
    `From: Tony Durante LLC <support@tonydurante.us>`,
    `To: ${clientEmail}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=UTF-8`,
  ]

  const raw = headers.join("\r\n") + "\r\n\r\n" + body
  const encodedRaw = Buffer.from(raw).toString("base64url")

  const result = await gmailPost("/drafts", {
    message: { raw: encodedRaw },
  }) as { id: string; message: { id: string } }

  return result
}

// ─── Tool Registration ──────────────────────────────────────

export function registerOfferTools(server: McpServer) {

  // ═══════════════════════════════════════
  // offer_list
  // ═══════════════════════════════════════
  server.tool(
    "offer_list",
    "List client offers/proposals with optional filters by status (draft/sent/viewed/signed/completed/expired) and language. Returns token, client name, status, dates, payment type, view count, and referrer name. Use offer_get with a token to see full offer details.",
    {
      status: z.string().optional().describe("Filter by status: draft, sent, viewed, signed, completed, expired"),
      language: z.enum(["en", "it"]).optional().describe("Filter by language"),
      limit: z.number().optional().default(25).describe("Max results"),
    },
    async ({ status, language, limit }) => {
      try {
        let q = supabaseAdmin
          .from("offers")
          .select("token, client_name, client_email, status, language, offer_date, payment_type, view_count, viewed_at, created_at, effective_date, expires_at, referrer_name, lead_id")
          .order("created_at", { ascending: false })
          .limit(Math.min(limit || 25, 100))

        if (status) q = q.eq("status", status)
        if (language) q = q.eq("language", language)

        const { data, error } = await q
        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ total: data?.length || 0, offers: data || [] }, null, 2),
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_list error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_get
  // ═══════════════════════════════════════
  server.tool(
    "offer_get",
    "Get complete offer details by token (e.g. 'mario-rossi-2026'). Returns all fields including: services, cost_summary, recurring_costs, intro text, payment links, bank details, strategy, next_steps, referrer info, access_code, and signed contract status. Also returns the public URL with access code.",
    {
      token: z.string().describe("Offer token (e.g. 'hamid-oumoumen-2026')"),
    },
    async ({ token }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("offers")
          .select("*")
          .eq("token", token)
          .single()

        if (error) throw error
        if (!data) return { content: [{ type: "text" as const, text: `❌ Offer not found: ${token}` }] }

        // Also check if there's a signed contract
        const { data: contract } = await supabaseAdmin
          .from("contracts")
          .select("id, client_name, client_email, signed_at, pdf_path, status, wire_receipt_path, payment_verified")
          .eq("offer_token", token)
          .maybeSingle()

        const accessCode = data.access_code || ""

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              offer: data,
              contract: contract || null,
              url: `https://offerte.tonydurante.us/?t=${token}&c=${accessCode}`,
            }, null, 2),
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_get error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_create
  // ═══════════════════════════════════════
  server.tool(
    "offer_create",
    `Create a new client offer/proposal in Supabase. Token must be unique (format: firstname-lastname-year). IMPORTANT: Set language to match the client's language (en or it). Status starts as 'draft' — use offer_send to approve, create Gmail draft, and set status='sent'. JSONB fields are validated — use correct field names. Returns the public URL with access code. Workflow: create (draft) → review via offer_get → offer_send → client views → signs → pays.`,
    {
      token: z.string().describe("Unique token (e.g. 'mario-rossi-2026')"),
      client_name: z.string().describe("Client full name"),
      client_email: z.string().optional().describe("Client email (required for email gate + Gmail draft)"),
      language: z.enum(["en", "it"]).describe("Offer language — MUST match client's language"),
      offer_date: z.string().optional().describe("Offer date (YYYY-MM-DD, defaults to today)"),
      payment_type: z.enum(["checkout", "bank_transfer", "none"]).describe("Payment method"),
      // Content fields (JSONB — validated)
      services: z.any().describe("Services: [{name, price, price_label?, description?, includes?[], recommended?}]"),
      cost_summary: z.any().describe("Cost summary: [{label, total?, total_label?, items?[{name, price}], rate?}]"),
      recurring_costs: z.any().optional().describe("Annual/recurring costs: [{label, price}]"),
      additional_services: z.any().optional().describe("Add-on services: same structure as services"),
      issues: z.any().optional().describe("Issues identified: [{title, description}]"),
      immediate_actions: z.any().optional().describe("Immediate actions: [{title, text?, description?}]"),
      strategy: z.any().optional().describe("Strategy steps: [{step_number, title, description}]"),
      next_steps: z.any().optional().describe("Next steps: [{step_number, title, description}]"),
      future_developments: z.any().optional().describe("Future developments: [{text}]"),
      intro_en: z.string().optional().describe("English intro (only if language=en)"),
      intro_it: z.string().optional().describe("Italian intro (only if language=it)"),
      payment_links: z.any().optional().describe("Whop payment links: [{url, label, amount}]"),
      bank_details: z.any().optional().describe("Bank transfer details: {beneficiary, iban, bic, bank_name, amount, reference}"),
      effective_date: z.string().optional().describe("Contract effective date (YYYY-MM-DD)"),
      expires_at: z.string().optional().describe("Expiry timestamp (ISO 8601)"),
      // Linking
      lead_id: z.string().optional().describe("Link to lead UUID"),
      deal_id: z.string().optional().describe("Link to deal UUID"),
      // Referrer tracking
      referrer_name: z.string().optional().describe("Referrer name (who referred this client)"),
      referrer_email: z.string().optional().describe("Referrer email"),
      referrer_type: z.enum(["client", "partner"]).optional().describe("Referrer type: 'client' (existing client) or 'partner'"),
      referrer_account_id: z.string().optional().describe("Referrer's CRM account UUID (if existing client)"),
      referrer_commission_type: z.enum(["percentage", "price_difference", "credit_note"]).optional().describe("Commission type"),
      referrer_commission_pct: z.number().optional().describe("Commission percentage (if type=percentage)"),
      referrer_agreed_price: z.number().optional().describe("Partner's agreed price (if type=price_difference)"),
      referrer_notes: z.string().optional().describe("Notes about referrer arrangement"),
    },
    async (params) => {
      try {
        // Validate JSONB fields
        const validationError = validateOfferJsonb(params as unknown as Record<string, unknown>)
        if (validationError) {
          return { content: [{ type: "text" as const, text: `❌ Validation error: ${validationError}` }] }
        }

        const { data, error } = await supabaseAdmin
          .from("offers")
          .insert({
            token: params.token,
            client_name: params.client_name,
            client_email: params.client_email,
            language: params.language,
            offer_date: params.offer_date || new Date().toISOString().split("T")[0],
            status: "draft",
            payment_type: params.payment_type,
            services: params.services,
            cost_summary: params.cost_summary,
            recurring_costs: params.recurring_costs,
            additional_services: params.additional_services,
            issues: params.issues,
            immediate_actions: params.immediate_actions,
            strategy: params.strategy,
            next_steps: params.next_steps,
            future_developments: params.future_developments,
            intro_en: params.intro_en,
            intro_it: params.intro_it,
            payment_links: params.payment_links,
            bank_details: params.bank_details,
            effective_date: params.effective_date,
            expires_at: params.expires_at,
            lead_id: params.lead_id,
            deal_id: params.deal_id,
            referrer_name: params.referrer_name,
            referrer_email: params.referrer_email,
            referrer_type: params.referrer_type,
            referrer_account_id: params.referrer_account_id,
            referrer_commission_type: params.referrer_commission_type,
            referrer_commission_pct: params.referrer_commission_pct,
            referrer_agreed_price: params.referrer_agreed_price,
            referrer_notes: params.referrer_notes,
            view_count: 0,
          })
          .select("token, access_code, status, client_name, language")
          .single()

        if (error) throw error

        const accessCode = data.access_code || ""

        logAction({
          action_type: "create",
          table_name: "offers",
          record_id: params.token,
          summary: `Created offer: ${params.client_name} (${params.token})`,
          details: { language: params.language, payment_type: params.payment_type, lead_id: params.lead_id },
        })

        // If lead_id provided, update lead's offer status
        if (params.lead_id) {
          const offerUrl = `https://offerte.tonydurante.us/?t=${params.token}&c=${accessCode}`
          await supabaseAdmin
            .from("leads")
            .update({ offer_link: offerUrl, offer_status: "Draft" })
            .eq("id", params.lead_id)
        }

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer created as DRAFT: ${params.token}\nURL: https://offerte.tonydurante.us/?t=${params.token}&c=${accessCode}\n\nReview with offer_get, then use offer_send to approve and create Gmail draft.`,
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_create error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_update
  // ═══════════════════════════════════════
  server.tool(
    "offer_update",
    "Update one or more fields of an existing offer by token. Only provided fields are changed — all others remain untouched. Use English column names: services, cost_summary, recurring_costs, issues, immediate_actions, strategy, next_steps, future_developments, additional_services. Use offer_get first to review current values. For approving and sending, use offer_send instead.",
    {
      token: z.string().describe("Offer token to update"),
      updates: z.record(z.string(), z.any()).describe("Object with fields to update (e.g. {status: 'sent', client_email: 'new@email.com'})"),
    },
    async ({ token, updates }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("offers")
          .update(updates)
          .eq("token", token)
          .select("token, client_name, status, language, payment_type")
          .single()

        if (error) throw error

        logAction({
          action_type: "update",
          table_name: "offers",
          record_id: token,
          summary: `Updated offer: ${data.client_name} (${token})`,
          details: { fields: Object.keys(updates) },
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer ${token} updated\n${JSON.stringify(data, null, 2)}`,
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_update error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_send — Approve offer + create Gmail draft
  // ═══════════════════════════════════════
  server.tool(
    "offer_send",
    "Approve an offer and create a Gmail draft to send it. Sets status to 'sent', creates a professional bilingual email draft in support@tonydurante.us with the offer link (including access code). Antonio reviews the draft in Gmail and sends manually. Requires client_email to be set on the offer. Use offer_get to review content before calling this.",
    {
      token: z.string().describe("Offer token to send"),
    },
    async ({ token }) => {
      try {
        // Get offer details
        const { data: offer, error: fetchError } = await supabaseAdmin
          .from("offers")
          .select("token, client_name, client_email, language, status, access_code, lead_id")
          .eq("token", token)
          .single()

        if (fetchError) throw fetchError
        if (!offer) return { content: [{ type: "text" as const, text: `❌ Offer not found: ${token}` }] }

        if (!offer.client_email) {
          return { content: [{ type: "text" as const, text: `❌ Cannot send: client_email is not set on this offer. Update it first with offer_update.` }] }
        }

        // Update status to sent
        const { error: updateError } = await supabaseAdmin
          .from("offers")
          .update({ status: "sent" })
          .eq("token", token)

        if (updateError) throw updateError

        // Update lead status if linked
        if (offer.lead_id) {
          await supabaseAdmin
            .from("leads")
            .update({ offer_status: "Sent" })
            .eq("id", offer.lead_id)
        }

        logAction({
          action_type: "send",
          table_name: "offers",
          record_id: token,
          summary: `Sent offer: ${offer.client_name} (${token}) to ${offer.client_email}`,
          details: { lead_id: offer.lead_id, language: offer.language },
        })

        // Create Gmail draft
        const draftResult = await createOfferDraft(
          offer.client_email,
          offer.client_name,
          token,
          offer.access_code || "",
          offer.language || "en",
        )

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer ${token} approved and Gmail draft created!\n\n📧 Draft ready in support@tonydurante.us\n   To: ${offer.client_email}\n   Draft ID: ${draftResult.id}\n\n🔗 Offer URL: https://offerte.tonydurante.us/?t=${token}&c=${offer.access_code}\n\nReview the draft in Gmail and send when ready.`,
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_send error: ${msg}` }] }
      }
    }
  )
}
