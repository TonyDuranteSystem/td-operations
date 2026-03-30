import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PORTAL_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"

// Document types allowed to be visible in the client portal Documents tab
const PORTAL_VISIBLE_DOC_TYPES = [
  "Form SS-4",
  "Articles of Organization",
  "Office Lease",
  "Operating Agreement",
  "EIN Letter (IRS)",
  "Form 8832",
]

// Mapping from document_type_name to Sign Documents page type
const DOC_TYPE_TO_SIGN_TYPE: Record<string, string> = {
  "Operating Agreement": "OA",
  "Office Lease": "Lease",
  "Form SS-4": "SS-4",
}

export function registerPortalTools(server: McpServer) {
  server.tool(
    "portal_legacy_onboard",
    `Prepare a legacy client for portal access. Run this before creating a portal account for any client that was onboarded before the portal existed.

What it does automatically:
1. Sets portal_visible=true on all allowed document types: Form SS-4, Articles of Organization, Office Lease, Operating Agreement, EIN Letter (IRS), Form 8832
2. Sets portal_visible=false on all other documents (passports, registered agent, etc.)

What it reports:
- Which documents will appear in the Documents tab
- Which documents will show as Signed in the Sign Documents page (from formal records OR documents table fallback)
- Which formal signature records are missing (lease needs suite number)
- Portal account status (exists / missing)
- Active services count

What you must still do manually:
- Create portal account: use portal_create_user
- Send portal login invite
- Create and send lease once suite number is assigned`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
    },
    async ({ account_id }) => {
      try {
        // 1. Get account
        const { data: account } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, entity_type, portal_account")
          .eq("id", account_id)
          .single()

        if (!account) return { content: [{ type: "text" as const, text: "❌ Account not found" }] }

        // 2. Get all documents for the account
        const { data: docs } = await supabaseAdmin
          .from("documents")
          .select("id, file_name, document_type_name, portal_visible, drive_link")
          .eq("account_id", account_id)
          .order("processed_at", { ascending: false })

        // 3. Update portal_visible: true for allowed types, false for everything else
        const allowedIds: string[] = []
        const hiddenIds: string[] = []
        const seenTypes = new Set<string>()

        for (const doc of docs ?? []) {
          const typeName = doc.document_type_name ?? ""
          if (PORTAL_VISIBLE_DOC_TYPES.includes(typeName) && !seenTypes.has(typeName)) {
            seenTypes.add(typeName)
            allowedIds.push(doc.id)
          } else {
            hiddenIds.push(doc.id)
          }
        }

        if (allowedIds.length > 0) {
          await supabaseAdmin.from("documents").update({ portal_visible: true }).in("id", allowedIds)
        }
        if (hiddenIds.length > 0) {
          await supabaseAdmin.from("documents").update({ portal_visible: false }).in("id", hiddenIds)
        }

        // 4. Check formal signature records
        const [oaRes, leaseRes, ss4Res] = await Promise.all([
          supabaseAdmin.from("oa_agreements").select("status, signed_at").eq("account_id", account_id).maybeSingle(),
          supabaseAdmin.from("lease_agreements").select("status, suite_number, signed_at").eq("account_id", account_id).maybeSingle(),
          supabaseAdmin.from("ss4_applications").select("status, signed_at").eq("account_id", account_id).maybeSingle(),
        ])

        // 5. Check Sign Documents fallback (documents table)
        const signDocStatus: Record<string, string> = {}
        for (const [typeName, label] of Object.entries(DOC_TYPE_TO_SIGN_TYPE)) {
          const hasFormal = (label === "OA" && oaRes.data) || (label === "Lease" && leaseRes.data) || (label === "SS-4" && ss4Res.data)
          const hasDriveDoc = (docs ?? []).find(d => d.document_type_name === typeName && d.drive_link)
          if (hasFormal) {
            const rec = label === "OA" ? oaRes.data : label === "Lease" ? leaseRes.data : ss4Res.data
            signDocStatus[label] = rec?.status === "signed" ? "✅ Signed (formal record)" : `⏳ Awaiting signature (formal record, status: ${rec?.status})`
          } else if (hasDriveDoc) {
            signDocStatus[label] = "✅ Signed (detected from documents table)"
          } else {
            signDocStatus[label] = "❌ Not found — document not in system"
          }
        }

        // 6. Lease special case
        if (leaseRes.data) {
          signDocStatus["Lease"] += leaseRes.data.suite_number ? ` — Suite ${leaseRes.data.suite_number}` : ""
        } else if (!signDocStatus["Lease"].includes("detected")) {
          signDocStatus["Lease"] = "⚠️ No lease record — create after assigning suite number"
        }

        // 7. Check portal user
        const { data: contacts } = await supabaseAdmin
          .from("account_contacts")
          .select("contact:contacts(full_name, email)")
          .eq("account_id", account_id)
          .limit(1)
        const primaryContact = contacts?.[0]?.contact as unknown as { full_name: string; email: string } | null
        let portalStatus = "❌ No portal account — run portal_create_user"
        if (primaryContact?.email) {
          const { data: users } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
          const exists = (users?.users ?? []).find(u => u.email === primaryContact.email)
          if (exists) portalStatus = `✅ Portal account exists (${primaryContact.email})`
        }

        // 8. Check active services
        const { count: serviceCount } = await supabaseAdmin
          .from("service_deliveries")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account_id)
          .eq("status", "active")

        // Build report
        const visibleDocs = (docs ?? []).filter(d => allowedIds.includes(d.id))
        const lines = [
          `✅ Legacy onboard complete: ${account.company_name}`,
          ``,
          `📄 Documents tab (${visibleDocs.length} visible):`,
          ...visibleDocs.map(d => `   • ${d.document_type_name} — ${d.file_name}`),
          hiddenIds.length > 0 ? `   (${hiddenIds.length} other docs hidden from portal)` : "",
          ``,
          `✍️ Sign Documents page:`,
          ...Object.entries(signDocStatus).map(([label, status]) => `   ${label}: ${status}`),
          ``,
          `🔐 Portal: ${portalStatus}`,
          `📦 Active services: ${serviceCount ?? 0}`,
          ``,
          `Next steps:`,
          account.portal_account ? "" : `  1. portal_create_user(account_id: "${account_id}")`,
          `  2. Send portal login invite`,
          `  3. Assign suite number → create lease`,
        ].filter(l => l !== undefined)

        logAction({
          action_type: "update",
          table_name: "documents",
          record_id: account_id,
          account_id,
          summary: `Legacy portal onboard: ${account.company_name} — ${visibleDocs.length} docs made visible`,
        })

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

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

        // Create auth user — contact_id is the center, portal finds accounts via junction table
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

        // Determine portal tier based on client state
        let portalTier = "lead"
        if (account_id) {
          // Check offers first
          const { data: offers } = await supabaseAdmin
            .from("offers")
            .select("status")
            .eq("account_id", account_id)
            .in("status", ["completed", "signed"])
            .limit(1)
          if (offers?.length) {
            portalTier = "onboarding"
          }

          // Check if legacy client with existing services/SS-4 (no offer in system)
          if (portalTier === "lead") {
            const { data: sds } = await supabaseAdmin
              .from("service_deliveries")
              .select("id")
              .eq("account_id", account_id)
              .limit(1)
            const { data: ss4s } = await supabaseAdmin
              .from("ss4_applications")
              .select("id")
              .eq("account_id", account_id)
              .limit(1)
            if (sds?.length || ss4s?.length) {
              portalTier = "active"
            }
          }

          // Update ACCOUNT portal flags
          await supabaseAdmin
            .from("accounts")
            .update({
              portal_account: true,
              portal_tier: portalTier,
              portal_created_date: new Date().toISOString().split("T")[0],
            })
            .eq("id", account_id)
        }

        // Update CONTACT portal_tier (source of truth for portal nav visibility)
        if (resolvedContactId) {
          await supabaseAdmin
            .from("contacts")
            .update({ portal_tier: portalTier })
            .eq("id", resolvedContactId)
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
