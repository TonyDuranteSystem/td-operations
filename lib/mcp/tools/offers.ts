/**
 * Offer Tools — Manage client offers/proposals in Supabase
 *
 * Offers are stored in the `offers` table (columns in English).
 * Live at: offerte.tonydurante.us/offer/{token}/{access_code}
 * Contract signing at: offerte.tonydurante.us/offer/{token}/contract
 *
 * Workflow: create (draft) → review → send (Gmail send) → client views → signs → pays
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"
import { logAction } from "@/lib/mcp/action-log"
import { safeSend } from "@/lib/mcp/safe-send"

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

function buildOfferEmail(
  clientEmail: string,
  clientName: string,
  token: string,
  accessCode: string,
  language: string,
  trackingPixelUrl?: string,
) {
  const offerUrl = `https://offerte.tonydurante.us/offer/${encodeURIComponent(token)}/${accessCode}`

  const subject = language === "en"
    ? `Your Proposal from Tony Durante LLC`
    : `La Tua Proposta da Tony Durante LLC`

  const htmlBody = language === "en"
    ? `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>Dear ${clientName},</p>
  <p>Thank you for your time during our consultation.</p>
  <p>Please find your personalized proposal at the following link:</p>
  <p style="margin: 24px 0;">
    <a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
      View Your Proposal
    </a>
  </p>
  <p>To view the proposal, you will be asked to verify your email address.</p>
  <p>If you have any questions, please don't hesitate to reach out.</p>
  <p style="margin-top: 24px;">Best regards,<br/><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>${trackingPixelUrl ? `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none" alt="" />` : ""}`
    : `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>Gentile ${clientName},</p>
  <p>Grazie per il tempo dedicato durante la nostra consulenza.</p>
  <p>Puoi consultare la tua proposta personalizzata al seguente link:</p>
  <p style="margin: 24px 0;">
    <a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
      Visualizza la Proposta
    </a>
  </p>
  <p>Per visualizzare la proposta, ti verrà chiesto di verificare il tuo indirizzo email.</p>
  <p>Per qualsiasi domanda, non esitare a contattarci.</p>
  <p style="margin-top: 24px;">Cordiali saluti,<br/><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>${trackingPixelUrl ? `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none" alt="" />` : ""}`

  const plainText = language === "en"
    ? `Dear ${clientName},\n\nThank you for your time during our consultation.\n\nPlease find your personalized proposal at the following link:\n${offerUrl}\n\nTo view the proposal, you will be asked to verify your email address.\n\nIf you have any questions, please don't hesitate to reach out.\n\nBest regards,\nTony Durante LLC\nsupport@tonydurante.us`
    : `Gentile ${clientName},\n\nGrazie per il tempo dedicato durante la nostra consulenza.\n\nPuoi consultare la tua proposta personalizzata al seguente link:\n${offerUrl}\n\nPer visualizzare la proposta, ti verrà chiesto di verificare il tuo indirizzo email.\n\nPer qualsiasi domanda, non esitare a contattarci.\n\nCordiali saluti,\nTony Durante LLC\nsupport@tonydurante.us`

  return { subject, htmlBody, plainText }
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
              url: `https://offerte.tonydurante.us/offer/${token}/${accessCode}`,
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

        // Auto-lookup referrer from lead if lead_id provided and no referrer_name set
        let refName = params.referrer_name || null
        let refEmail = params.referrer_email || null
        let refType = params.referrer_type || null
        let refAccountId = params.referrer_account_id || null
        let refCommissionType = params.referrer_commission_type || null
        let refCommissionPct = params.referrer_commission_pct ?? null
        const refAgreedPrice = params.referrer_agreed_price ?? null
        const refNotes = params.referrer_notes || null
        let referralAutoFilled = false

        if (params.lead_id && !params.referrer_name) {
          const { data: lead } = await supabaseAdmin
            .from("leads")
            .select("referrer_name, referrer_partner_id, source")
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
              refCommissionType = "credit_note"
              refCommissionPct = 10
            }
          }
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
            bank_details: params.bank_details || {
              beneficiary: "TONY DURANTE L.L.C.",
              account_number: "200000306770",
              routing_number: "064209588",
              bank_name: "Relay Financial",
              address: "11761 80th Ave, Seminole, FL 33772",
            },
            effective_date: params.effective_date,
            expires_at: params.expires_at,
            lead_id: params.lead_id,
            deal_id: params.deal_id,
            referrer_name: refName,
            referrer_email: refEmail,
            referrer_type: refType,
            referrer_account_id: refAccountId,
            referrer_commission_type: refCommissionType,
            referrer_commission_pct: refCommissionPct,
            referrer_agreed_price: refAgreedPrice,
            referrer_notes: refNotes,
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
          summary: `Created offer: ${params.client_name} (${params.token})${refName ? ` — referral: ${refName}` : ""}`,
          details: { language: params.language, payment_type: params.payment_type, lead_id: params.lead_id, referrer: refName },
        })

        // If lead_id provided, update lead's offer status
        if (params.lead_id) {
          const offerUrl = `https://offerte.tonydurante.us/offer/${params.token}/${accessCode}`
          await supabaseAdmin
            .from("leads")
            .update({ offer_link: offerUrl, offer_status: "Draft" })
            .eq("id", params.lead_id)
        }

        const referralLine = referralAutoFilled
          ? `\n📎 Referral auto-filled from lead: ${refName} (${refType}, ${refCommissionType || "no commission type"}${refCommissionPct ? ` ${refCommissionPct}%` : ""})`
          : ""

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer created as DRAFT: ${params.token}\nURL: https://offerte.tonydurante.us/offer/${params.token}/${accessCode}${referralLine}\n\nReview with offer_get, then use offer_send to approve and create Gmail draft.`,
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
  // offer_send — Approve offer + send via Gmail (uses safeSend)
  // ═══════════════════════════════════════
  server.tool(
    "offer_send",
    `Approve an offer and send the link to the client via Gmail with open tracking. Sets status to 'sent'. Email is sent immediately (NOT a draft). Requires client_email to be set on the offer. Use offer_get to review content before calling this.`,
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

        // Generate tracking ID
        const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const pixelUrl = `https://td-operations.vercel.app/api/track/open/${trackingId}`

        // Build email
        const { subject, htmlBody, plainText } = buildOfferEmail(
          offer.client_email,
          offer.client_name,
          token,
          offer.access_code || "",
          offer.language || "en",
          pixelUrl,
        )

        // Build MIME multipart/alternative (text + html)
        const fromEmail = "support@tonydurante.us"
        const boundary = `boundary_${Date.now()}`

        // RFC 2047: encode subject as base64 if it contains non-ASCII chars
        const hasNonAscii = /[^\x00-\x7F]/.test(subject)
        const encodedSubject = hasNonAscii
          ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
          : subject

        const mimeHeaders = [
          `From: Tony Durante LLC <${fromEmail}>`,
          `To: ${offer.client_email}`,
          `Subject: ${encodedSubject}`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ]
        const mimeParts = [
          mimeHeaders.join("\r\n"),
          "",
          `--${boundary}`,
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(plainText).toString("base64"),
          "",
          `--${boundary}`,
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(htmlBody).toString("base64"),
          "",
          `--${boundary}--`,
        ]
        const encodedRaw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

        // ─── safeSend: email FIRST, status updates AFTER ───
        const result = await safeSend<{ id: string; threadId: string }>({
          // Idempotency: don't send if already sent
          idempotencyCheck: async () => {
            if (offer.status === "sent") {
              const { data: existing } = await supabaseAdmin
                .from("email_tracking")
                .select("tracking_id, created_at")
                .eq("recipient", offer.client_email!)
                .ilike("subject", `%Proposal%Tony Durante%`)
                .limit(1)
              if (existing?.length) {
                return {
                  alreadySent: true,
                  message: [
                    `⚠️ Offer email already sent for "${token}"`,
                    ``,
                    `Tracking: ${existing[0].tracking_id}`,
                    `Sent at: ${existing[0].created_at}`,
                    ``,
                    `Use gmail_track_status to check if the client opened it.`,
                    `To resend, first use offer_update to set status back to "draft".`,
                  ].join("\n"),
                }
              }
            }
            return null
          },

          // SEND FIRST — actual Gmail send
          sendFn: async () => {
            return await gmailPost("/messages/send", {
              raw: encodedRaw,
            }) as { id: string; threadId: string }
          },

          // POST-SEND: status updates + tracking (only after send succeeds)
          postSendSteps: [
            {
              name: "save_tracking",
              fn: async () => {
                await supabaseAdmin.from("email_tracking").insert({
                  tracking_id: trackingId,
                  recipient: offer.client_email,
                  subject,
                  from_email: fromEmail,
                })
              },
            },
            {
              name: "update_offer_status",
              fn: async () => {
                await supabaseAdmin
                  .from("offers")
                  .update({ status: "sent" })
                  .eq("token", token)
              },
            },
            {
              name: "update_lead_status",
              fn: async () => {
                if (offer.lead_id) {
                  await supabaseAdmin
                    .from("leads")
                    .update({ offer_status: "Sent" })
                    .eq("id", offer.lead_id)
                }
              },
            },
          ],
        })

        // Handle idempotency
        if (result.alreadySent) {
          return { content: [{ type: "text" as const, text: result.idempotencyMessage! }] }
        }

        logAction({
          action_type: "send",
          table_name: "offers",
          record_id: token,
          summary: `Sent offer: ${offer.client_name} (${token}) to ${offer.client_email}`,
          details: {
            lead_id: offer.lead_id,
            language: offer.language,
            gmail_message_id: result.sendResult?.id,
            tracking_id: trackingId,
          },
        })

        const statusLine = result.hasWarnings
          ? `⚠️ Email sent but some follow-up steps had issues`
          : `✅ Offer email sent via Gmail`

        return {
          content: [{
            type: "text" as const,
            text: [
              statusLine,
              ``,
              `📧 To: ${offer.client_email}`,
              `📋 Subject: ${subject}`,
              `🆔 Message ID: ${result.sendResult?.id}`,
              `👁️ Open tracking: ${trackingId}`,
              ``,
              `🔗 Offer URL: https://offerte.tonydurante.us/?t=${token}&c=${offer.access_code}`,
              ``,
              result.hasWarnings ? `⚠️ Steps: ${result.steps.map(s => `${s.step}=${s.status}`).join(", ")}` : "",
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_send error: ${msg}` }] }
      }
    }
  )
}
