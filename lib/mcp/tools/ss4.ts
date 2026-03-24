/**
 * SS-4 (EIN Application) MCP Tools
 *
 * Tools:
 *   ss4_create — Create a pre-filled SS-4 application from CRM account data
 *   ss4_get    — Get SS-4 details by token or account_id
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { APP_BASE_URL } from "@/lib/config"

export function registerSs4Tools(server: McpServer) {

  // ───────────────────────────────────────────────────────────
  // ss4_create
  // ───────────────────────────────────────────────────────────
  server.tool(
    "ss4_create",
    `Create a pre-filled SS-4 (EIN Application) for a client's LLC. Pulls data from CRM account + primary contact.

Prerequisites:
- Account must exist with company_name, state_of_formation, and formation_date
- Account must have at least one linked contact (the responsible party)

Entity type rules (auto-detected from account):
- SMLLC: Line 9a = "Other: Foreign owned disregarded entity", title = "Owner"
- MMLLC: Line 9a = "Partnership", title = "Member"

The SS-4 is created as 'draft'. Client signs it in the portal (Sign Documents page).
After signing, Luca receives a notification to fax it to the IRS.

Admin preview: ${APP_BASE_URL}/ss4/{token}/{access_code}?preview=td
ALWAYS provide the admin preview link after creating.

Workflow: ss4_create → client sees it in portal → signs → Luca faxes to IRS → EIN received.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID for responsible party (auto-detects primary contact if omitted)"),
      entity_type: z.enum(["SMLLC", "MMLLC", "Corporation"]).optional().describe("Entity type (auto-detected from account.entity_type if omitted)"),
      member_count: z.number().optional().describe("Number of LLC members (auto: 1 for SMLLC, from account_contacts for MMLLC)"),
    },
    async (params) => {
      try {
        // ─── 1. FETCH ACCOUNT ───
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, entity_type, state_of_formation, formation_date, ein_number")
          .eq("id", params.account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `Error: Account not found: ${accErr?.message || "no data"}` }] }
        }

        if (!account.state_of_formation) {
          return { content: [{ type: "text" as const, text: `Error: Account "${account.company_name}" missing state_of_formation.` }] }
        }

        // Check if SS-4 already exists for this account
        const { data: existing } = await supabaseAdmin
          .from("ss4_applications")
          .select("id, token, status")
          .eq("account_id", params.account_id)
          .maybeSingle()

        if (existing) {
          return { content: [{ type: "text" as const, text: `SS-4 already exists for ${account.company_name} (token: ${existing.token}, status: ${existing.status}). Use ss4_get to view it.` }] }
        }

        // ─── 2. DETECT ENTITY TYPE ───
        const ENTITY_MAP: Record<string, string> = {
          "SINGLE MEMBER LLC": "SMLLC", "SMLLC": "SMLLC",
          "MULTI-MEMBER LLC": "MMLLC", "MULTI MEMBER LLC": "MMLLC", "MMLLC": "MMLLC",
          "CORPORATION": "Corporation", "CORP": "Corporation", "C-CORP": "Corporation",
        }
        const rawEntity = params.entity_type || (account.entity_type || "").toUpperCase().trim()
        const entityType = ENTITY_MAP[rawEntity] || "SMLLC"

        // ─── 3. NORMALIZE STATE ───
        const STATE_MAP: Record<string, string> = {
          "NEW MEXICO": "NM", "NM": "NM",
          "WYOMING": "WY", "WY": "WY",
          "FLORIDA": "FL", "FL": "FL",
          "DELAWARE": "DE", "DE": "DE",
        }
        const state = STATE_MAP[(account.state_of_formation || "").toUpperCase().trim()] || account.state_of_formation

        // ─── 4. FETCH CONTACT (responsible party) ───
        let contactId = params.contact_id
        if (!contactId) {
          const { data: links } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id")
            .eq("account_id", params.account_id)
            .limit(1)

          if (!links?.length) {
            return { content: [{ type: "text" as const, text: `Error: No contacts linked to account "${account.company_name}". Link a contact first.` }] }
          }
          contactId = links[0].contact_id
        }

        const { data: contact, error: ctErr } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, itin_number, phone, language")
          .eq("id", contactId)
          .single()

        if (ctErr || !contact) {
          return { content: [{ type: "text" as const, text: `Error: Contact not found: ${ctErr?.message || "no data"}` }] }
        }

        // ─── 5. DETERMINE MEMBER COUNT ───
        let memberCount = params.member_count
        if (!memberCount) {
          if (entityType === "SMLLC") {
            memberCount = 1
          } else {
            const { count } = await supabaseAdmin
              .from("account_contacts")
              .select("*", { count: "exact", head: true })
              .eq("account_id", params.account_id)
            memberCount = count || 2
          }
        }

        // ─── 6. BUILD TOKEN ───
        const slug = account.company_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "")
        const token = `ss4-${slug}-${new Date().getFullYear()}`

        // ─── 7. INSERT RECORD ───
        const title = entityType === "SMLLC" ? "Owner" : entityType === "MMLLC" ? "Member" : "President"

        const { data: ss4, error: insertErr } = await supabaseAdmin
          .from("ss4_applications")
          .insert({
            token,
            account_id: params.account_id,
            contact_id: contactId,
            company_name: account.company_name,
            entity_type: entityType,
            state_of_formation: state,
            formation_date: account.formation_date || null,
            member_count: memberCount,
            responsible_party_name: contact.full_name,
            responsible_party_itin: contact.itin_number || null,
            responsible_party_phone: contact.phone || null,
            responsible_party_title: title,
            language: contact.language === "Italian" ? "it" : "en",
            status: "draft",
          })
          .select("id, token, access_code, status")
          .single()

        if (insertErr || !ss4) {
          return { content: [{ type: "text" as const, text: `Error creating SS-4: ${insertErr?.message || "insert failed"}` }] }
        }

        // ─── 8. LOG ACTION ───
        await logAction({
          action_type: "create",
          table_name: "ss4_applications",
          record_id: ss4.id,
          account_id: params.account_id,
          summary: `Created SS-4 for ${account.company_name} (${entityType}, ${state})`,
        })

        // ─── 9. RETURN RESULT ───
        const previewUrl = `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`

        return {
          content: [{
            type: "text" as const,
            text: [
              `SS-4 created for ${account.company_name}`,
              ``,
              `Token: ${ss4.token}`,
              `Status: ${ss4.status}`,
              `Entity: ${entityType} (${memberCount} member${memberCount > 1 ? "s" : ""})`,
              `State: ${state}`,
              `Responsible Party: ${contact.full_name}`,
              ``,
              `Admin Preview: ${previewUrl}`,
              ``,
              `The client will see this in their portal Sign Documents page.`,
            ].join("\n"),
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // ss4_get
  // ───────────────────────────────────────────────────────────
  server.tool(
    "ss4_get",
    `Get SS-4 application details by token or account_id. Returns all fields including status, signing info, and preview URL.`,
    {
      token: z.string().optional().describe("SS-4 token (e.g. 'ss4-outriders-llc-2026')"),
      account_id: z.string().uuid().optional().describe("Account UUID"),
    },
    async (params) => {
      try {
        let query = supabaseAdmin
          .from("ss4_applications")
          .select("*")

        if (params.token) {
          query = query.eq("token", params.token)
        } else if (params.account_id) {
          query = query.eq("account_id", params.account_id).order("created_at", { ascending: false }).limit(1)
        } else {
          return { content: [{ type: "text" as const, text: "Error: Provide either token or account_id" }] }
        }

        const { data: ss4, error } = await query.maybeSingle()

        if (error || !ss4) {
          return { content: [{ type: "text" as const, text: `SS-4 not found: ${error?.message || "no data"}` }] }
        }

        const previewUrl = `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`

        return {
          content: [{
            type: "text" as const,
            text: [
              `SS-4 Application: ${ss4.company_name}`,
              ``,
              `ID: ${ss4.id}`,
              `Token: ${ss4.token}`,
              `Status: ${ss4.status}`,
              `Entity: ${ss4.entity_type} (${ss4.member_count} member${ss4.member_count > 1 ? "s" : ""})`,
              `State: ${ss4.state_of_formation}`,
              `Formation Date: ${ss4.formation_date || "N/A"}`,
              `Responsible Party: ${ss4.responsible_party_name}`,
              `ITIN: ${ss4.responsible_party_itin || "Foreigner"}`,
              ``,
              ss4.signed_at ? `Signed: ${ss4.signed_at}` : "Not yet signed",
              ss4.pdf_signed_drive_id ? `Signed PDF (Drive): ${ss4.pdf_signed_drive_id}` : "",
              ``,
              `Views: ${ss4.view_count || 0}`,
              `Created: ${ss4.created_at}`,
              ``,
              `Admin Preview: ${previewUrl}`,
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )
}
