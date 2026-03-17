/**
 * Tax Quote Tools — Create intake form links for tax return quotes.
 * Flow: tax_quote_create → client fills form → auto-creates lead + draft offer → we review & send.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"

export function registerTaxQuoteTools(server: McpServer) {

  server.tool(
    "tax_quote_create",
    `Create a tax return quote request form for a prospect. Returns a public URL the client fills in with their LLC details (name, state, type, tax year). On submit, the system auto-creates a lead + draft offer with correct pricing ($1,000 SM LLC / $1,500 MM or C Corp). Admin preview: append ?preview=td. URL: ${APP_BASE_URL}/tax-quote/{token}. After client submits, review auto-created offer with offer_get, adjust with offer_update if needed, then send via offer_send.`,
    {
      client_name: z.string().describe("Prospect's name"),
      client_email: z.string().email().optional().describe("Email (optional — client provides on form)"),
      language: z.enum(["en", "it"]).optional().default("en").describe("Form language"),
    },
    async ({ client_name, client_email, language }) => {
      try {
        const slug = client_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 30)
        const year = new Date().getFullYear()
        const token = `tax-quote-${slug}-${year}`

        // Check for existing
        const { data: existing } = await supabaseAdmin
          .from("tax_quote_submissions")
          .select("id, token, status")
          .eq("token", token)
          .maybeSingle()

        if (existing) {
          const url = `${APP_BASE_URL}/tax-quote/${existing.token}`
          return {
            content: [{
              type: "text" as const,
              text: `Already exists: ${url}\nStatus: ${existing.status}\nAdmin preview: ${url}?preview=td`,
            }],
          }
        }

        // Insert
        const { error } = await supabaseAdmin
          .from("tax_quote_submissions")
          .insert({
            token,
            client_name,
            client_email: client_email || null,
            language: language || "en",
            status: "pending",
          })

        if (error) throw error

        const url = `${APP_BASE_URL}/tax-quote/${token}`
        return {
          content: [{
            type: "text" as const,
            text: [
              `Tax quote form created for ${client_name}`,
              `Token: ${token}`,
              ``,
              `Admin Preview: ${url}?preview=td`,
              `Client URL: ${url}`,
              ``,
              `Send the client URL via gmail_send. On submit, system auto-creates lead + draft offer.`,
            ].join("\n"),
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ tax_quote_create error: ${msg}` }] }
      }
    },
  )
}
