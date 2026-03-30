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
  "ITIN Letter",
]

// Mapping from document_type_name to Sign Documents page type
const DOC_TYPE_TO_SIGN_TYPE: Record<string, string> = {
  "Operating Agreement": "OA",
  "Office Lease": "Lease",
  "Form SS-4": "SS-4",
}

// Account fields required for a complete portal experience
const REQUIRED_ACCOUNT_FIELDS = [
  "ein_number",
  "formation_date",
  "entity_type",
  "state_of_formation",
] as const

export function registerPortalTools(server: McpServer) {
  server.tool(
    "portal_legacy_onboard",
    `Prepare a legacy client for portal access. Run this BEFORE creating a portal account for any client onboarded before the portal existed.

What it does:
1. Sets portal_visible on documents (true for allowed types, false for everything else)
2. Audits the full portal environment: account data, contacts, services, deadlines, tax returns, payments, documents, sign documents
3. Reports a readiness score and lists exactly what's missing or needs fixing

Allowed document types (visible in portal): Form SS-4, Articles of Organization, Office Lease, Operating Agreement, EIN Letter (IRS), Form 8832, ITIN Letter

After running this tool, review the output and fix any gaps before creating the portal account with portal_create_user.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
    },
    async ({ account_id }) => {
      try {
        // 1. Get account with all relevant fields
        const { data: account } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, drive_folder_id, portal_account, portal_tier")
          .eq("id", account_id)
          .single()

        if (!account) return { content: [{ type: "text" as const, text: "Account not found" }] }

        // 2. Parallel queries for all data
        const [
          docsRes,
          oaRes,
          leaseRes,
          ss4Res,
          contactsRes,
          servicesRes,
          legacyServicesRes,
          deadlinesRes,
          taxReturnsRes,
          paymentsRes,
        ] = await Promise.all([
          supabaseAdmin.from("documents")
            .select("id, file_name, document_type_name, portal_visible, drive_link")
            .eq("account_id", account_id)
            .order("processed_at", { ascending: false }),
          supabaseAdmin.from("oa_agreements")
            .select("status, signed_at")
            .eq("account_id", account_id)
            .maybeSingle(),
          supabaseAdmin.from("lease_agreements")
            .select("status, suite_number, signed_at")
            .eq("account_id", account_id)
            .maybeSingle(),
          supabaseAdmin.from("ss4_applications")
            .select("status, signed_at")
            .eq("account_id", account_id)
            .maybeSingle(),
          supabaseAdmin.from("account_contacts")
            .select("contact:contacts(id, full_name, email, phone)")
            .eq("account_id", account_id),
          supabaseAdmin.from("service_deliveries")
            .select("id, service_name, service_type, stage, status")
            .eq("account_id", account_id)
            .in("status", ["active", "completed"]),
          supabaseAdmin.from("services")
            .select("id, service_name, service_type, status")
            .eq("account_id", account_id),
          supabaseAdmin.from("deadlines")
            .select("id, deadline_type, due_date, status")
            .eq("account_id", account_id),
          supabaseAdmin.from("tax_returns")
            .select("id, tax_year, return_type, status")
            .eq("company_name", account.company_name),
          supabaseAdmin.from("payments")
            .select("id, status")
            .eq("account_id", account_id),
        ])

        const docs = docsRes.data ?? []
        const sds = servicesRes.data ?? []
        const legacyServices = legacyServicesRes.data ?? []
        const deadlines = deadlinesRes.data ?? []
        const taxReturns = taxReturnsRes.data ?? []
        const payments = paymentsRes.data ?? []
        const contacts = contactsRes.data ?? []

        // 3. Update portal_visible on documents
        const allowedIds: string[] = []
        const hiddenIds: string[] = []
        const seenTypes = new Set<string>()

        for (const doc of docs) {
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

        // 4. Build sections
        const lines: string[] = []
        const issues: string[] = []
        let checksTotal = 0
        let checksPassed = 0

        // --- ACCOUNT ---
        checksTotal++
        const missingFields = REQUIRED_ACCOUNT_FIELDS.filter(f => !account[f])
        if (missingFields.length === 0) checksPassed++
        else issues.push(`Account missing: ${missingFields.join(", ")}`)

        lines.push(`== LEGACY PORTAL ONBOARD: ${account.company_name} ==`)
        lines.push("")
        lines.push("--- ACCOUNT ---")
        lines.push(`Status: ${account.status} | Entity: ${account.entity_type ?? "?"} | State: ${account.state_of_formation ?? "?"}`)
        lines.push(`EIN: ${account.ein_number ?? "MISSING"} | Formation: ${account.formation_date ?? "MISSING"}`)
        lines.push(`Drive folder: ${account.drive_folder_id ? "OK" : "MISSING"} | Portal tier: ${account.portal_tier ?? "not set"}`)
        if (missingFields.length > 0) lines.push(`Missing fields: ${missingFields.join(", ")}`)

        // --- CONTACT ---
        checksTotal++
        const primaryContact = contacts[0]?.contact as unknown as { id: string; full_name: string; email: string; phone: string } | null
        if (primaryContact?.email) checksPassed++
        else issues.push("No contact with email linked to account")

        lines.push("")
        lines.push("--- CONTACT ---")
        if (primaryContact) {
          lines.push(`Primary: ${primaryContact.full_name} (${primaryContact.email ?? "NO EMAIL"}) | Phone: ${primaryContact.phone ?? "none"}`)
        } else {
          lines.push("No contact linked to account")
        }

        // Portal account check
        checksTotal++
        let portalAccountExists = false
        if (account.portal_account) {
          portalAccountExists = true
          checksPassed++
          lines.push("Portal account: EXISTS")
        } else if (primaryContact?.email) {
          const { data: users } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
          const exists = (users?.users ?? []).find(u => u.email === primaryContact.email)
          if (exists) {
            portalAccountExists = true
            checksPassed++
            lines.push(`Portal account: EXISTS (${primaryContact.email})`)
          } else {
            lines.push("Portal account: NOT CREATED")
            issues.push("No portal account -- run portal_create_user")
          }
        } else {
          lines.push("Portal account: CANNOT CREATE (no email)")
          issues.push("Cannot create portal account without contact email")
        }

        // --- DOCUMENTS ---
        const visibleDocs = docs.filter(d => allowedIds.includes(d.id))
        const missingTypes = PORTAL_VISIBLE_DOC_TYPES.filter(t => !seenTypes.has(t))

        lines.push("")
        lines.push("--- DOCUMENTS ---")
        lines.push(`Visible (${visibleDocs.length}):`)
        for (const d of visibleDocs) {
          lines.push(`  ${d.document_type_name}`)
        }
        lines.push(`Hidden: ${hiddenIds.length} docs`)
        if (missingTypes.length > 0) {
          lines.push(`Not in system: ${missingTypes.join(", ")}`)
        }

        // --- SIGN DOCUMENTS ---
        lines.push("")
        lines.push("--- SIGN DOCUMENTS ---")
        const signDocStatus: Record<string, string> = {}
        for (const [typeName, label] of Object.entries(DOC_TYPE_TO_SIGN_TYPE)) {
          const hasFormal = (label === "OA" && oaRes.data) || (label === "Lease" && leaseRes.data) || (label === "SS-4" && ss4Res.data)
          const hasDriveDoc = docs.find(d => d.document_type_name === typeName && d.drive_link)
          if (hasFormal) {
            const rec = label === "OA" ? oaRes.data : label === "Lease" ? leaseRes.data : ss4Res.data
            signDocStatus[label] = rec?.status === "signed" ? "Signed (formal)" : `Awaiting signature (${rec?.status})`
          } else if (hasDriveDoc) {
            signDocStatus[label] = "Signed (detected from documents)"
          } else {
            signDocStatus[label] = "Not found"
          }
        }

        if (leaseRes.data?.suite_number) {
          signDocStatus["Lease"] += ` -- Suite ${leaseRes.data.suite_number}`
        } else if (!signDocStatus["Lease"].includes("detected") && !signDocStatus["Lease"].includes("formal")) {
          signDocStatus["Lease"] = "No lease -- create after suite assignment"
        }

        for (const [label, status] of Object.entries(signDocStatus)) {
          lines.push(`  ${label}: ${status}`)
        }

        // --- SERVICES ---
        checksTotal++
        lines.push("")
        lines.push("--- SERVICES ---")
        if (sds.length > 0) {
          checksPassed++
          lines.push(`Service deliveries: ${sds.length}`)
          for (const sd of sds) {
            lines.push(`  ${sd.service_name ?? sd.service_type} -- ${sd.stage} (${sd.status})`)
          }
        } else if (legacyServices.length > 0) {
          checksPassed++
          lines.push(`No service_deliveries, but ${legacyServices.length} legacy services found`)
          for (const s of legacyServices) {
            lines.push(`  ${s.service_name ?? s.service_type} (${s.status})`)
          }
          lines.push("Note: Portal Services page uses service_deliveries first, falls back to services")
        } else {
          lines.push("No services -- portal Services page will be EMPTY")
          issues.push("No service deliveries or legacy services")
        }

        // --- TAX RETURNS ---
        checksTotal++
        lines.push("")
        lines.push("--- TAX RETURNS ---")
        if (taxReturns.length > 0) {
          checksPassed++
          for (const tr of taxReturns) {
            lines.push(`  ${tr.tax_year} ${tr.return_type}: ${tr.status}`)
          }
        } else {
          lines.push("None tracked")
          issues.push("No tax returns in system")
        }

        // --- DEADLINES ---
        checksTotal++
        lines.push("")
        lines.push("--- DEADLINES ---")
        const pendingDeadlines = deadlines.filter(d => d.status === "Pending")
        const overdueDeadlines = deadlines.filter(d => d.status === "Overdue")
        if (deadlines.length > 0) {
          checksPassed++
          lines.push(`${pendingDeadlines.length} pending, ${overdueDeadlines.length} overdue`)
          for (const d of [...overdueDeadlines, ...pendingDeadlines].slice(0, 5)) {
            lines.push(`  ${d.deadline_type}: ${d.due_date} (${d.status})`)
          }
        } else {
          lines.push("None -- consider creating Annual Report / RA Renewal deadlines")
          issues.push("No deadlines")
        }

        // --- PAYMENTS ---
        checksTotal++
        lines.push("")
        lines.push("--- PAYMENTS ---")
        if (payments.length > 0) {
          checksPassed++
          const paid = payments.filter(p => p.status === "paid").length
          const pending = payments.filter(p => p.status === "pending").length
          const overdue = payments.filter(p => p.status === "overdue").length
          lines.push(`${paid} paid, ${pending} pending, ${overdue} overdue (${payments.length} total)`)
        } else {
          lines.push("No payment records")
          issues.push("No payments in CRM")
        }

        // --- READINESS SCORE ---
        lines.push("")
        lines.push(`--- READINESS: ${checksPassed}/${checksTotal} ---`)
        if (issues.length > 0) {
          lines.push("Issues:")
          for (const issue of issues) {
            lines.push(`  - ${issue}`)
          }
        }

        // --- NEXT STEPS ---
        const nextSteps: string[] = []
        if (!portalAccountExists) nextSteps.push(`portal_create_user(account_id: "${account_id}")`)
        if (missingFields.length > 0) nextSteps.push(`Update account: fill ${missingFields.join(", ")}`)
        if (sds.length === 0 && legacyServices.length === 0) nextSteps.push("Create service deliveries with sd_create")
        if (deadlines.length === 0) nextSteps.push("Create compliance deadlines")
        if (!account.portal_tier) nextSteps.push("Set portal_tier on account (recommend: 'active')")

        if (nextSteps.length > 0) {
          lines.push("")
          lines.push("Next steps:")
          nextSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
        }

        logAction({
          action_type: "update",
          table_name: "documents",
          record_id: account_id,
          account_id,
          summary: `Legacy portal onboard: ${account.company_name} -- ${visibleDocs.length} docs visible, readiness ${checksPassed}/${checksTotal}`,
        })

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  server.tool(
    "portal_create_user",
    "Create a portal login for a client. Creates a Supabase Auth user with client role, sets temp password, marks account as portal-enabled. Returns login URL + temp password. For LLC clients: pass account_id. For leads without account: pass email + full_name directly.",
    {
      account_id: z.string().uuid().optional().describe("CRM account UUID (for LLC clients)"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      email: z.string().optional().describe("Email address (for leads without account -- use instead of account_id)"),
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
              return { content: [{ type: "text" as const, text: "No contacts linked to this account" }] }
            }
            targetContactId = links[0].contact_id
          }

          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("full_name, email")
            .eq("id", targetContactId)
            .single()

          if (!contact?.email) {
            return { content: [{ type: "text" as const, text: "Contact has no email address" }] }
          }
          userEmail = contact.email
          userName = contact.full_name
        }

        if (!userEmail) {
          return { content: [{ type: "text" as const, text: "Either account_id or email is required" }] }
        }

        // Check if user already exists
        const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        const existingUser = (existingList?.users ?? []).find(u => u.email === userEmail)

        if (existingUser) {
          return { content: [{ type: "text" as const, text: `Portal user already exists: ${userEmail}` }] }
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

        // Create auth user -- contact_id is the center, portal finds accounts via junction table
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
          return { content: [{ type: "text" as const, text: createError.message }] }
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
            const { data: existingSds } = await supabaseAdmin
              .from("service_deliveries")
              .select("id")
              .eq("account_id", account_id)
              .limit(1)
            const { data: ss4s } = await supabaseAdmin
              .from("ss4_applications")
              .select("id")
              .eq("account_id", account_id)
              .limit(1)
            if (existingSds?.length || ss4s?.length) {
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
              `Portal account created`,
              `${userName} (${userEmail})`,
              `Temp password: ${tempPassword}`,
              `Login: ${loginUrl}`,
              ``,
              `Client will be asked to change password on first login.`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )
}
