import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PORTAL_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"

export function registerPortalTools(server: McpServer) {
  server.tool(
    "portal_create_user",
    "Create a portal login for a client. Creates a Supabase Auth user with client role, sets temp password, marks account as portal-enabled. Returns login URL + temp password. For LLC clients: pass account_id. For leads without account: pass email + full_name directly.",
    {
      account_id: z.string().uuid().optional().describe("CRM account UUID (for LLC clients)"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      email: z.string().optional().describe("Email address (for leads without account — use instead of account_id)"),
      full_name: z.string().optional().describe("Full name (for leads without account)"),
    },
    async ({ account_id, contact_id, email: directEmail, full_name: directName }) => {
      try {
        let userEmail = directEmail
        let userName = directName || "Client"

        // If account_id provided, get contact from account
        if (account_id && !directEmail) {
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

          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("full_name, email")
            .eq("id", targetContactId)
            .single()

          if (!contact?.email) {
            return { content: [{ type: "text" as const, text: "❌ Contact has no email address" }] }
          }
          userEmail = contact.email
          userName = contact.full_name
        }

        if (!userEmail) {
          return { content: [{ type: "text" as const, text: "❌ Either account_id or email is required" }] }
        }

        // Check if user already exists
        const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        const existingUser = (existingList?.users ?? []).find(u => u.email === userEmail)

        if (existingUser) {
          return { content: [{ type: "text" as const, text: `⚠️ Portal user already exists: ${userEmail}` }] }
        }

        // Generate temp password
        const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

        // Resolve contact_id for app_metadata (required for portal page access)
        let resolvedContactId = contact_id
        if (!resolvedContactId && account_id) {
          const { data: links } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id")
            .eq("account_id", account_id)
            .limit(1)
          resolvedContactId = links?.[0]?.contact_id || undefined
        }

        // Create auth user
        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email: userEmail,
          password: tempPassword,
          email_confirm: true,
          app_metadata: {
            role: "client",
            ...(resolvedContactId ? { contact_id: resolvedContactId } : {}),
          },
          user_metadata: {
            full_name: userName,
            must_change_password: true,
          },
        })

        if (createError) {
          return { content: [{ type: "text" as const, text: `❌ ${createError.message}` }] }
        }

        // Update account portal flags (if account exists)
        if (account_id) {
          // Check if offer is completed (paid) — if so, set tier to "active"
          let portalTier = "lead"
          const { data: offers } = await supabaseAdmin
            .from("offers")
            .select("status")
            .eq("account_id", account_id)
            .in("status", ["completed", "signed"])
            .limit(1)
          if (offers?.length) {
            portalTier = offers[0].status === "completed" ? "active" : "onboarding"
          }
          // Also check by lead_id linked to account
          if (portalTier === "lead") {
            const { data: acct } = await supabaseAdmin
              .from("accounts")
              .select("status")
              .eq("id", account_id)
              .single()
            if (acct?.status === "Active") portalTier = "active"
          }

          await supabaseAdmin
            .from("accounts")
            .update({
              portal_account: true,
              portal_tier: portalTier,
              portal_created_date: new Date().toISOString().split("T")[0],
            })
            .eq("id", account_id)
        }

        logAction({
          action_type: "create",
          table_name: "auth.users",
          record_id: newUser.user.id,
          account_id: account_id || undefined,
          summary: `Portal user created: ${userName} (${userEmail})`,
        })

        const loginUrl = `${PORTAL_BASE_URL}/portal/login`

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Portal account created`,
              `👤 ${userName} (${userEmail})`,
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
