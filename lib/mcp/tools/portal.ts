import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PORTAL_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"

export function registerPortalTools(server: McpServer) {
  server.tool(
    "portal_create_user",
    "Create a portal login for a client. Creates a Supabase Auth user with client role, sets temp password, marks account as portal-enabled. Returns login URL + temp password. Use crm_get_client_summary first to find account_id.",
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
    },
    async ({ account_id, contact_id }) => {
      try {
        // Get the contact
        let targetContactId = contact_id
        if (!targetContactId) {
          const { data: links } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id")
            .eq("account_id", account_id)
            .limit(1)

          if (!links?.length) {
            return { content: [{ type: "text" as const, text: "❌ No contacts linked to this account" }] }
          }
          targetContactId = links[0].contact_id
        }

        // Get contact details
        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("full_name, email")
          .eq("id", targetContactId)
          .single()

        if (!contact?.email) {
          return { content: [{ type: "text" as const, text: "❌ Contact has no email address" }] }
        }

        // Check if user already exists
        const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        const existingUser = (existingList?.users ?? []).find(u => u.email === contact.email)

        if (existingUser) {
          return { content: [{ type: "text" as const, text: `⚠️ Portal user already exists: ${contact.email}` }] }
        }

        // Generate temp password
        const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

        // Create auth user
        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email: contact.email,
          password: tempPassword,
          email_confirm: true,
          app_metadata: {
            role: "client",
            contact_id: targetContactId,
          },
          user_metadata: {
            full_name: contact.full_name,
            must_change_password: true,
          },
        })

        if (createError) {
          return { content: [{ type: "text" as const, text: `❌ ${createError.message}` }] }
        }

        // Update account portal flags
        await supabaseAdmin
          .from("accounts")
          .update({
            portal_account: true,
            portal_created_date: new Date().toISOString().split("T")[0],
          })
          .eq("id", account_id)

        logAction({
          action_type: "create",
          table_name: "auth.users",
          record_id: newUser.user.id,
          account_id,
          summary: `Portal user created: ${contact.full_name} (${contact.email})`,
        })

        const loginUrl = `${PORTAL_BASE_URL}/portal/login`

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Portal account created`,
              `👤 ${contact.full_name} (${contact.email})`,
              `🔑 Temp password: ${tempPassword}`,
              `🔗 Login: ${loginUrl}`,
              ``,
              `Client will be asked to change password on first login.`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )
}
