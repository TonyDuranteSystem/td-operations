/**
 * Member Info Form MCP Tools
 *
 * Tools:
 *   member_info_form_create — Create (or retrieve existing) member info request for an MMLLC account.
 *                             Pre-populates from existing members table. Returns form URL only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getOrCreateMemberInfoRequest } from "@/lib/members/member-info-request"

export function registerMemberInfoTools(server: McpServer) {

  // ───────────────────────────────────────────────────────────
  // member_info_form_create
  // ───────────────────────────────────────────────────────────
  server.tool(
    "member_info_form_create",
    `Create a member info request form for a legacy MMLLC account. Used when existing members need to submit their information (names, ownership %, addresses, representative details for company members).

Idempotent: if a pending request already exists for the account, returns it instead of creating a duplicate.

Pre-populates the form with any existing member data already in the members table.

Returns:
- form_url: direct link to the form (send to primary member)
- admin_preview_url: ?preview=td version for internal testing
- context: company name, members with missing info, primary recipient — use this to draft the email

IMPORTANT — email drafting: do NOT use any hardcoded or generic template. After receiving the form URL and context, compose an email draft that fits the actual reason this form is being sent (e.g. portal access setup, formation completion, bank account opening, compliance update). The tone, language (EN/IT based on contact.language), and framing must match the specific situation. Always show the draft to Antonio for approval before sending.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID (must be an MMLLC account)"),
    },
    async ({ account_id }) => {
      // Identity + request creation delegated entirely to the shared core
      // (lib/members/member-info-request.ts::getOrCreateMemberInfoRequest) —
      // this tool used to hand-roll its own is_primary-ONLY lookup with no
      // fallback (no resolver, no email fallback, no any-linked-contact
      // fallback), so it dead-ended for any account the web routes could
      // already fix. Bug-Hunter, dev job 9ad76300-6181-4250-a1de-c77f37933f82, third pass.
      const result = await getOrCreateMemberInfoRequest(account_id)
      if (result.outcome === "error") {
        return { content: [{ type: "text", text: `❌ ${result.message}` }] }
      }
      const { formUrl, adminPreviewUrl, isExisting, companyName, contactId } = result

      // Members list + recipient contact are fetched separately, for EMAIL
      // DRAFTING CONTEXT only — they play no part in deciding who the
      // request belongs to.
      const { data: allMembers } = await supabaseAdmin
        .from("members")
        .select("member_type, full_name, company_name, email, ownership_pct, is_primary, contact_id")
        .eq("account_id", account_id)
        .order("is_primary", { ascending: false })

      const { data: recipientContact } = await supabaseAdmin
        .from("contacts")
        .select("full_name, email")
        .eq("id", contactId)
        .maybeSingle()

      const membersWithMissingInfo = (allMembers ?? []).filter(
        m => !m.email || (!m.full_name && !m.company_name)
      )

      const lines = [
        `✅ Member info form ${isExisting ? "(existing)" : "created"} for **${companyName}**`,
        ``,
        `**Form URL:** ${formUrl}`,
        `**Admin Preview:** ${adminPreviewUrl}`,
        ``,
        `**Context for email drafting:**`,
        `- Recipient: ${recipientContact?.full_name || "unknown"} (${recipientContact?.email || "no email"})`,
        `- Members with incomplete info: ${membersWithMissingInfo.length > 0 ? membersWithMissingInfo.map(m => m.full_name || m.company_name || "unnamed").join(", ") : "none — all have emails"}`,
        `- Total members: ${allMembers?.length ?? 0}`,
        ``,
        `Draft an email appropriate to the actual reason this form is being sent. Match language (EN/IT) to the recipient. Show draft to Antonio before sending.`,
      ]

      return { content: [{ type: "text", text: lines.join("\n") }] }
    },
  )
}
