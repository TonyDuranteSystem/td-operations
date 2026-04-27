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
- MMLLC: Line 9a = "Partnership", title = "Member". IMPORTANT: For MMLLC with multiple members, you MUST provide contact_id to specify which member signs. If omitted, the tool will list all members and ask you to choose.
- Corporation: Line 9a = "Corporation" + "1120", title = "President". After EIN is received, Form 8832 must be filed for C-Corp election.

By default the SS-4 is created as 'draft' for admin review. Pass ready_to_sign=true to create it directly at 'awaiting_signature' so it appears in the client's portal Sign Documents page immediately without a manual status flip.
After signing, Luca receives a notification to fax it to the IRS.

Admin preview: ${APP_BASE_URL}/ss4/{token}/{access_code}?preview=td
ALWAYS provide the admin preview link after creating.

Workflow: ss4_create → client sees it in portal → signs → Luca faxes to IRS → EIN received.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID for responsible party (auto-detects primary contact if omitted)"),
      entity_type: z.enum(["SMLLC", "MMLLC", "Corporation"]).optional().describe("Entity type (auto-detected from account.entity_type if omitted)"),
      member_count: z.number().optional().describe("Number of LLC members (auto: 1 for SMLLC, from account_contacts for MMLLC)"),
      ready_to_sign: z.boolean().optional().describe("If true, creates the record at 'awaiting_signature' so it surfaces in the client's portal Sign Documents page immediately. Default false (creates at 'draft' for admin review first)."),
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
        // Primary source: members table. Fallback: account_contacts (legacy accounts with 0 members rows).
        let contactId = params.contact_id
        if (!contactId) {
          const { data: membersRows } = await supabaseAdmin
            .from("members")
            .select("id, member_type, full_name, company_name, email, representative_name, representative_email, contact_id, is_primary")
            .eq("account_id", params.account_id)
            .order("is_primary", { ascending: false })

          if (membersRows && membersRows.length > 0) {
            // For MMLLC with multiple members: require explicit contact_id selection
            if (entityType === "MMLLC" && membersRows.length > 1) {
              const memberList = await Promise.all(membersRows.map(async (m, i) => {
                if (m.member_type === "company") {
                  // Resolve representative contact_id by email
                  let repContactId = m.contact_id
                  if (!repContactId && m.representative_email) {
                    const { data: repC } = await supabaseAdmin.from("contacts").select("id").eq("email", m.representative_email).maybeSingle()
                    repContactId = repC?.id ?? null
                  }
                  const repInfo = m.representative_name ? ` (rep: ${m.representative_name})` : ""
                  return `  ${i + 1}. [Company] ${m.company_name || "Unknown"}${repInfo} — contact_id: ${repContactId || "no contact"}`
                }
                return `  ${i + 1}. ${m.full_name || "Unknown"} — contact_id: ${m.contact_id || "no contact"}`
              }))

              return { content: [{ type: "text" as const, text: [
                `This is a Multi-Member LLC with ${membersRows.length} members. Please specify which member will sign the SS-4 as the responsible party.`,
                ``,
                `Members:`,
                ...memberList,
                ``,
                `Re-run ss4_create with the contact_id of the chosen member.`,
              ].join("\n") }] }
            }

            // Single member or SMLLC: use first row
            const m = membersRows[0]
            if (m.member_type === "company" && m.representative_email) {
              const { data: repC } = await supabaseAdmin.from("contacts").select("id").eq("email", m.representative_email).maybeSingle()
              contactId = repC?.id ?? m.contact_id
            } else {
              contactId = m.contact_id
            }
          } else {
            // Legacy fallback: account_contacts
            const { data: links } = await supabaseAdmin
              .from("account_contacts")
              .select("contact_id, role, contacts(id, full_name, email)")
              .eq("account_id", params.account_id)

            if (!links?.length) {
              return { content: [{ type: "text" as const, text: `Error: No contacts linked to account "${account.company_name}". Link a contact first.` }] }
            }

            if (entityType === "MMLLC" && links.length > 1) {
              const memberList = links.map((l, i) => {
                const c = l.contacts as unknown as { id: string; full_name: string; email: string } | null
                return `  ${i + 1}. ${c?.full_name || "Unknown"} (${(l as unknown as { role: string }).role || "Member"}) — contact_id: ${l.contact_id}`
              }).join("\n")

              return { content: [{ type: "text" as const, text: [
                `This is a Multi-Member LLC with ${links.length} members. Please specify which member will sign the SS-4 as the responsible party.`,
                ``,
                `Members:`,
                memberList,
                ``,
                `Re-run ss4_create with the contact_id of the chosen member.`,
              ].join("\n") }] }
            }

            contactId = links[0].contact_id
          }
        }

        if (!contactId) {
          return { content: [{ type: "text" as const, text: `Error: Could not resolve responsible party contact for "${account.company_name}". Link a contact or specify contact_id.` }] }
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
        // Primary source: members table. Fallback: account_contacts (legacy).
        let memberCount = params.member_count
        if (!memberCount) {
          if (entityType === "SMLLC") {
            memberCount = 1
          } else {
            const { count: membersCount } = await supabaseAdmin
              .from("members")
              .select("*", { count: "exact", head: true })
              .eq("account_id", params.account_id)
            if (membersCount && membersCount > 0) {
              memberCount = membersCount
            } else {
              const { count: acCount } = await supabaseAdmin
                .from("account_contacts")
                .select("*", { count: "exact", head: true })
                .eq("account_id", params.account_id)
              memberCount = acCount || 2
            }
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
            language: "en", // SS-4 is always English (IRS form)
            status: params.ready_to_sign ? "awaiting_signature" : "draft",
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
  // ss4_update
  // ───────────────────────────────────────────────────────────
  server.tool(
    "ss4_update",
    `Update fields on an existing SS-4 application. If the record is at 'awaiting_signature', updating any content field resets it to 'draft' so the client sees the corrected version before re-signing.

Use cases:
- Correct responsible party (new contact_id + name/ITIN/phone)
- Fix member_count
- Add county_and_state or trade_name
- Promote draft → awaiting_signature (pass status='awaiting_signature' explicitly)
- Reset to draft after a signing error

Note: signed records (status='signed') cannot be updated.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("New responsible party contact UUID"),
      member_count: z.number().optional().describe("Corrected member count"),
      county_and_state: z.string().optional().describe("County and state of principal business address"),
      trade_name: z.string().optional().describe("Trade name / DBA (if any)"),
      status: z.enum(["draft", "awaiting_signature"]).optional().describe("Explicitly set status (omit to let the tool auto-manage)"),
    },
    async (params) => {
      try {
        const { data: ss4, error: fetchErr } = await supabaseAdmin
          .from("ss4_applications")
          .select("id, token, status, company_name, access_code")
          .eq("account_id", params.account_id)
          .maybeSingle()

        if (fetchErr || !ss4) {
          return { content: [{ type: "text" as const, text: `Error: SS-4 not found for this account: ${fetchErr?.message || "no data"}` }] }
        }

        if (ss4.status === "signed") {
          return { content: [{ type: "text" as const, text: `Error: SS-4 for ${ss4.company_name} is already signed — it cannot be modified.` }] }
        }

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

        // Resolve new responsible party if contact_id provided
        if (params.contact_id) {
          const { data: contact, error: ctErr } = await supabaseAdmin
            .from("contacts")
            .select("id, full_name, itin_number, phone")
            .eq("id", params.contact_id)
            .single()

          if (ctErr || !contact) {
            return { content: [{ type: "text" as const, text: `Error: Contact not found: ${ctErr?.message || "no data"}` }] }
          }

          updates.contact_id = params.contact_id
          updates.responsible_party_name = contact.full_name
          updates.responsible_party_itin = contact.itin_number || null
          updates.responsible_party_phone = contact.phone || null
        }

        if (params.member_count !== undefined) updates.member_count = params.member_count
        if (params.county_and_state !== undefined) updates.county_and_state = params.county_and_state
        if (params.trade_name !== undefined) updates.trade_name = params.trade_name

        const contentFieldsChanged = Object.keys(updates).some(k => k !== "updated_at" && k !== "status")

        // Status logic: explicit override wins; otherwise reset to draft if content changed while awaiting_signature
        if (params.status) {
          updates.status = params.status
        } else if (contentFieldsChanged && ss4.status === "awaiting_signature") {
          updates.status = "draft"
        }

        const { error: updateErr } = await supabaseAdmin
          .from("ss4_applications")
          .update(updates)
          .eq("id", ss4.id)

        if (updateErr) {
          return { content: [{ type: "text" as const, text: `Error updating SS-4: ${updateErr.message}` }] }
        }

        await logAction({
          action_type: "update",
          table_name: "ss4_applications",
          record_id: ss4.id,
          account_id: params.account_id,
          summary: `Updated SS-4 for ${ss4.company_name} — fields: ${Object.keys(updates).filter(k => k !== "updated_at").join(", ")}`,
        })

        const newStatus = (updates.status as string | undefined) || ss4.status
        const previewUrl = `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`
        const resetNote = updates.status === "draft" && ss4.status === "awaiting_signature"
          ? "\n⚠️  Status reset to draft — content was changed while record was awaiting_signature."
          : ""

        return {
          content: [{
            type: "text" as const,
            text: [
              `SS-4 updated for ${ss4.company_name}`,
              `Status: ${newStatus}`,
              `Fields updated: ${Object.keys(updates).filter(k => k !== "updated_at" && k !== "status").join(", ") || "none"}`,
              resetNote,
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
