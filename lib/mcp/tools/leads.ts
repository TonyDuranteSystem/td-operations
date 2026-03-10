/**
 * Lead Tools — Search, create, get, and update leads in the sales pipeline.
 * Leads are prospects tracked from first contact through conversion to client.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerLeadTools(server: McpServer) {

  // ═══════════════════════════════════════
  // lead_search
  // ═══════════════════════════════════════
  server.tool(
    "lead_search",
    "Search leads by name, status, source, channel, or language. Returns lead name, email, phone, status (New/Call Scheduled/Call Done/Offer Sent/Negotiating/Converted/Lost/Suspended), source, reason, and offer info. Use lead_get for full details including linked call summaries and offers.",
    {
      query: z.string().optional().describe("Search text (matches full_name or email, case-insensitive)"),
      status: z.string().optional().describe("Lead status: New, Call Scheduled, Call Done, Offer Sent, Negotiating, Converted, Lost, Suspended"),
      source: z.string().optional().describe("Lead source (e.g., Referral, Website, Social)"),
      channel: z.string().optional().describe("Communication channel"),
      language: z.string().optional().describe("Language preference (English, Italian)"),
      limit: z.number().optional().default(25).describe("Max results (default 25, max 100)"),
    },
    async ({ query, status, source, channel, language, limit }) => {
      try {
        let q = supabaseAdmin
          .from("leads")
          .select("id, full_name, email, phone, source, referrer_name, reason, channel, call_date, status, language, offer_status, offer_link, offer_date, notes, created_at")
          .order("created_at", { ascending: false })
          .limit(Math.min(limit || 25, 100))

        if (query) q = q.or(`full_name.ilike.%${query}%,email.ilike.%${query}%`)
        if (status) q = q.eq("status", status)
        if (source) q = q.ilike("source", `%${source}%`)
        if (channel) q = q.eq("channel", channel)
        if (language) q = q.ilike("language", `%${language}%`)

        const { data, error } = await q
        if (error) throw new Error(error.message)

        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No leads found." }] }
        }

        // Group by status for visual overview
        const byStatus: Record<string, typeof data> = {}
        for (const lead of data) {
          const s = lead.status || "Unknown"
          if (!byStatus[s]) byStatus[s] = []
          byStatus[s].push(lead)
        }

        const statusIcons: Record<string, string> = {
          "New": "🆕",
          "Call Scheduled": "📅",
          "Call Done": "📞",
          "Offer Sent": "📨",
          "Negotiating": "🤝",
          "Converted": "✅",
          "Lost": "❌",
          "Suspended": "⏸️",
        }

        const lines: string[] = [`📋 Leads (${data.length})`, ""]

        for (const [status, leads] of Object.entries(byStatus)) {
          const icon = statusIcons[status] || "•"
          lines.push(`${icon} ${status.toUpperCase()} (${leads.length})`)

          for (const lead of leads) {
            const date = lead.call_date || lead.created_at?.slice(0, 10) || ""
            const ref = lead.referrer_name ? ` ← ${lead.referrer_name}` : ""
            const src = lead.source ? ` [${lead.source}]` : ""

            lines.push(`   ${lead.full_name}${src}${ref}`)
            lines.push(`   ${lead.email || "no email"} | ${lead.phone || "no phone"} | ${date}`)
            if (lead.reason) lines.push(`   Reason: ${lead.reason}`)
            if (lead.offer_status) lines.push(`   Offer: ${lead.offer_status}${lead.offer_link ? ` → ${lead.offer_link}` : ""}`)
            lines.push(`   ID: ${lead.id}`)
            lines.push("")
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error searching leads: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // lead_get
  // ═══════════════════════════════════════
  server.tool(
    "lead_get",
    "Get full lead details by ID or name — includes all fields, linked call summaries from Circleback, and offer data. Use lead_search first to find the lead ID, or pass a name for fuzzy match.",
    {
      id: z.string().uuid().optional().describe("Lead UUID (from lead_search)"),
      name: z.string().optional().describe("Lead name (fuzzy match if no ID)"),
    },
    async ({ id, name }) => {
      try {
        let q = supabaseAdmin.from("leads").select("*")
        if (id) {
          q = q.eq("id", id)
        } else if (name) {
          q = q.ilike("full_name", `%${name}%`)
        } else {
          return { content: [{ type: "text" as const, text: "Provide either id or name." }] }
        }

        const { data: leads, error } = await q
        if (error) throw new Error(error.message)
        if (!leads || leads.length === 0) {
          return { content: [{ type: "text" as const, text: "Lead not found." }] }
        }

        const lead = leads[0]

        // Fetch linked call summaries
        const { data: calls } = await supabaseAdmin
          .from("call_summaries")
          .select("id, meeting_name, duration_seconds, notes, action_items, created_at")
          .eq("lead_id", lead.id)
          .order("created_at", { ascending: false })

        const statusIcons: Record<string, string> = {
          "New": "🆕", "Call Scheduled": "📅", "Call Done": "📞",
          "Offer Sent": "📨", "Negotiating": "🤝", "Converted": "✅",
          "Lost": "❌", "Suspended": "⏸️",
        }

        const icon = statusIcons[lead.status] || "•"
        const lines: string[] = [
          `${icon} ${lead.full_name}`,
          "",
          `Status: ${lead.status || "Unknown"}`,
          `Email: ${lead.email || "—"}`,
          `Phone: ${lead.phone || "—"}`,
          `Language: ${lead.language || "—"}`,
          `Source: ${lead.source || "—"}`,
        ]

        if (lead.referrer_name) lines.push(`Referrer: ${lead.referrer_name}`)
        if (lead.reason) lines.push(`Reason: ${lead.reason}`)
        if (lead.channel) lines.push(`Channel: ${lead.channel}`)
        if (lead.call_date) lines.push(`Call Date: ${lead.call_date}`)
        if (lead.notes) lines.push(`Notes: ${lead.notes}`)

        // Offer info
        if (lead.offer_status || lead.offer_link) {
          lines.push("")
          lines.push("── Offer ──")
          if (lead.offer_status) lines.push(`Status: ${lead.offer_status}`)
          if (lead.offer_date) lines.push(`Date: ${lead.offer_date}`)
          if (lead.offer_link) lines.push(`Link: ${lead.offer_link}`)
          if (lead.offer_year1_amount) lines.push(`Year 1: ${lead.offer_year1_currency || "EUR"} ${lead.offer_year1_amount}`)
          if (lead.offer_annual_amount) lines.push(`Annual: ${lead.offer_annual_currency || "USD"} ${lead.offer_annual_amount}`)
          if (lead.offer_services) lines.push(`Services: ${Array.isArray(lead.offer_services) ? lead.offer_services.join(", ") : lead.offer_services}`)
          if (lead.offer_notes) lines.push(`Notes: ${lead.offer_notes}`)
        }

        // Conversion info
        if (lead.converted_at) {
          lines.push("")
          lines.push("── Conversion ──")
          lines.push(`Converted: ${new Date(lead.converted_at).toLocaleDateString("en-US")}`)
          if (lead.converted_to_account_id) lines.push(`Account: ${lead.converted_to_account_id}`)
          if (lead.converted_to_contact_id) lines.push(`Contact: ${lead.converted_to_contact_id}`)
        }

        // Call summaries
        if (calls && calls.length > 0) {
          lines.push("")
          lines.push("── Call Summaries ──")
          for (const call of calls) {
            const date = new Date(call.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            const mins = call.duration_seconds ? Math.round(call.duration_seconds / 60) : 0
            lines.push(`📞 ${call.meeting_name || "Call"} — ${date} (${mins} min)`)

            if (call.notes && typeof call.notes === "string") {
              const preview = call.notes.length > 200 ? call.notes.slice(0, 200) + "..." : call.notes
              lines.push(`   ${preview}`)
            }

            if (Array.isArray(call.action_items) && call.action_items.length > 0) {
              lines.push(`   Action items: ${call.action_items.length}`)
              for (const item of call.action_items.slice(0, 5)) {
                const text = typeof item === "string" ? item : item.text || item.description || JSON.stringify(item)
                lines.push(`   • ${text}`)
              }
            }
            lines.push(`   Call ID: ${call.id}`)
            lines.push("")
          }
        }

        lines.push(`ID: ${lead.id}`)
        lines.push(`Created: ${new Date(lead.created_at).toLocaleDateString("en-US")}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // lead_create
  // ═══════════════════════════════════════
  server.tool(
    "lead_create",
    "Create a new lead after a Calendly call, referral, or inbound inquiry. Checks for duplicate email/phone before creating. Returns the new lead with ID. After creation, use cb_list_calls to link any existing call summaries.",
    {
      full_name: z.string().describe("Full name of the lead"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      source: z.string().optional().describe("How they found us (Referral, Website, Social, Calendly, WhatsApp)"),
      referrer_name: z.string().optional().describe("Who referred them"),
      referrer_partner_id: z.string().uuid().optional().describe("Partner UUID if referred by a partner"),
      reason: z.string().optional().describe("Why they're reaching out (e.g., 'Apertura LLC', 'Tax Return')"),
      channel: z.string().optional().describe("Communication channel (WhatsApp, Email, Calendly, Phone)"),
      call_date: z.string().optional().describe("Date of consultation call (YYYY-MM-DD)"),
      language: z.string().optional().describe("Preferred language (English, Italian)"),
      notes: z.string().optional().describe("Additional notes"),
      status: z.string().optional().describe("Initial status (default: New). Use 'Call Done' if call already happened."),
    },
    async ({ full_name, email, phone, source, referrer_name, referrer_partner_id, reason, channel, call_date, language, notes, status }) => {
      try {
        // Check for duplicates
        if (email) {
          const { data: existing } = await supabaseAdmin
            .from("leads")
            .select("id, full_name, status")
            .ilike("email", email)
            .limit(1)

          if (existing && existing.length > 0) {
            return { content: [{ type: "text" as const, text: `⚠️ Duplicate: Lead already exists with email ${email}\n→ ${existing[0].full_name} (${existing[0].status}) — ID: ${existing[0].id}` }] }
          }
        }

        if (phone) {
          const cleanPhone = phone.replace(/[\s\-\(\)]/g, "")
          const { data: existing } = await supabaseAdmin
            .from("leads")
            .select("id, full_name, status")
            .ilike("phone", `%${cleanPhone.slice(-8)}%`)
            .limit(1)

          if (existing && existing.length > 0) {
            return { content: [{ type: "text" as const, text: `⚠️ Possible duplicate: Lead with similar phone exists\n→ ${existing[0].full_name} (${existing[0].status}) — ID: ${existing[0].id}` }] }
          }
        }

        // Split name
        const nameParts = full_name.trim().split(/\s+/)
        const first_name = nameParts[0]
        const last_name = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined

        const insert: Record<string, unknown> = {
          full_name: full_name.trim(),
          first_name,
          last_name,
          email: email || null,
          phone: phone || null,
          source: source || null,
          referrer_name: referrer_name || null,
          referrer_partner_id: referrer_partner_id || null,
          reason: reason || null,
          channel: channel || null,
          call_date: call_date || null,
          language: language || "English",
          notes: notes || null,
          status: status || "New",
        }

        const { data, error } = await supabaseAdmin
          .from("leads")
          .insert(insert)
          .select("*")
          .single()

        if (error) throw new Error(error.message)

        return { content: [{ type: "text" as const, text: `✅ Lead created: ${data.full_name}\nStatus: ${data.status}\nID: ${data.id}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error creating lead: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // lead_update
  // ═══════════════════════════════════════
  server.tool(
    "lead_update",
    "Update a lead's fields (status, notes, offer data, etc.). Use lead_search first to find the ID. For status changes: New → Call Scheduled → Call Done → Offer Sent → Negotiating → Converted/Lost.",
    {
      id: z.string().uuid().describe("Lead UUID (from lead_search)"),
      updates: z.record(z.string(), z.any()).describe("Fields to update (e.g., {status: 'Call Done', notes: 'Discussed LLC formation'})"),
    },
    async ({ id, updates }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("leads")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select("id, full_name, status, offer_status")
          .single()

        if (error) throw new Error(error.message)

        return { content: [{ type: "text" as const, text: `✅ Lead updated: ${data.full_name}\nStatus: ${data.status}${data.offer_status ? ` | Offer: ${data.offer_status}` : ""}\nID: ${data.id}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error updating lead: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}
