/**
 * Offer Tools — Manage client offers/proposals in Supabase
 *
 * Offers are stored in the `offers` table.
 * Live at: offerte.tonydurante.us/?t={token}
 * Contract signing at: offerte.tonydurante.us/contract.html?t={token}
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerOfferTools(server: McpServer) {

  // ═══════════════════════════════════════
  // offer_list — List all offers with filters
  // ═══════════════════════════════════════
  server.tool(
    "offer_list",
    "List client offers/proposals with optional filters. Returns token, client name, status, dates, payment type.",
    {
      status: z.string().optional().describe("Filter by status: draft, sent, viewed, signed, completed, expired"),
      language: z.enum(["en", "it"]).optional().describe("Filter by language"),
      limit: z.number().optional().default(25).describe("Max results"),
    },
    async ({ status, language, limit }) => {
      try {
        let q = supabaseAdmin
          .from("offers")
          .select("token, client_name, client_email, status, language, offer_date, payment_type, view_count, viewed_at, created_at, effective_date, expires_at")
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
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ offer_list error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_get — Get full offer by token
  // ═══════════════════════════════════════
  server.tool(
    "offer_get",
    "Get complete offer details by token. Returns all fields including services, costs, intro text, payment links, and bank details.",
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
          .select("id, client_name, client_email, signed_at, pdf_path, status")
          .eq("offer_token", token)
          .maybeSingle()

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              offer: data,
              contract: contract || null,
              url: `https://offerte.tonydurante.us/?t=${token}`,
            }, null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ offer_get error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_create — Create a new offer
  // ═══════════════════════════════════════
  server.tool(
    "offer_create",
    "Create a new client offer in Supabase. The token must be unique (format: firstname-lastname-year). Returns the offer URL. IMPORTANT: Set language to match the client's language (en or it).",
    {
      token: z.string().describe("Unique token (e.g. 'mario-rossi-2026')"),
      client_name: z.string().describe("Client full name"),
      client_email: z.string().optional().describe("Client email"),
      language: z.enum(["en", "it"]).describe("Offer language — MUST match client's language"),
      offer_date: z.string().optional().describe("Offer date (YYYY-MM-DD, defaults to today)"),
      payment_type: z.enum(["checkout", "bank_transfer", "none"]).describe("Payment method"),
      servizi: z.any().describe("Services array: [{name, price, price_label, description, includes[], recommended}]"),
      riepilogo_costi: z.any().describe("Cost summary: [{label, total, total_label, items[{name, price}], rate}]"),
      intro_en: z.string().optional().describe("English intro (only if language=en)"),
      intro_it: z.string().optional().describe("Italian intro (only if language=it)"),
      payment_links: z.any().optional().describe("Whop payment links: [{url, label, amount}]"),
      bank_details: z.any().optional().describe("Bank transfer details: {beneficiary, iban, bic, bank_name, amount, reference}"),
      criticita: z.any().optional().describe("Issues: [{title, description}]"),
      azioni_immediate: z.any().optional().describe("Immediate actions: [{title, text}]"),
      strategia: z.any().optional().describe("Strategy: [{step_number, title, description}]"),
      prossimi_passi: z.any().optional().describe("Next steps: [{step_number, title, description}]"),
      sviluppi_futuri: z.any().optional().describe("Future developments: [{text}]"),
      effective_date: z.string().optional().describe("Contract effective date (YYYY-MM-DD)"),
      expires_at: z.string().optional().describe("Expiry timestamp (ISO 8601)"),
    },
    async (params) => {
      try {
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
            servizi: params.servizi,
            riepilogo_costi: params.riepilogo_costi,
            intro_en: params.intro_en,
            intro_it: params.intro_it,
            payment_links: params.payment_links,
            bank_details: params.bank_details,
            criticita: params.criticita,
            azioni_immediate: params.azioni_immediate,
            strategia: params.strategia,
            prossimi_passi: params.prossimi_passi,
            sviluppi_futuri: params.sviluppi_futuri,
            effective_date: params.effective_date,
            expires_at: params.expires_at,
            view_count: 0,
          })
          .select()
          .single()

        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer created: ${params.token}\nURL: https://offerte.tonydurante.us/?t=${params.token}\n\n${JSON.stringify(data, null, 2)}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ offer_create error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_update — Update offer fields
  // ═══════════════════════════════════════
  server.tool(
    "offer_update",
    "Update one or more fields of an existing offer by token. Only provided fields are updated.",
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

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer ${token} updated\n${JSON.stringify(data, null, 2)}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ offer_update error: ${err.message}` }] }
      }
    }
  )
}
