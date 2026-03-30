import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PORTAL_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"
import { collectFilesRecursive, processFile } from "@/lib/mcp/tools/doc"

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
1. Scans Google Drive for unprocessed files and processes them (OCR + classify + store)
2. Sets portal_visible on documents (true for allowed types, false for everything else)
3. Audits the full portal environment: account data, contacts, services, deadlines, tax returns, payments, documents, sign documents
4. Reports a readiness score and lists exactly what's missing or needs fixing

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
          .select("id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, drive_folder_id, portal_account, portal_tier, services_bundle")
          .eq("id", account_id)
          .single()

        if (!account) return { content: [{ type: "text" as const, text: "Account not found" }] }

        // 2. Scan Drive for unprocessed files (if folder linked)
        let driveProcessed = 0
        let driveSkipped = 0
        if (account.drive_folder_id) {
          const allFiles = await collectFilesRecursive(account.drive_folder_id, 3)
          if (allFiles.length > 0) {
            // Check which are already processed
            const fileIds = allFiles.map(f => f.id)
            const existingIds = new Set<string>()
            for (let i = 0; i < fileIds.length; i += 50) {
              const chunk = fileIds.slice(i, i + 50)
              const { data: existing } = await supabaseAdmin
                .from("documents")
                .select("drive_file_id")
                .in("drive_file_id", chunk)
              existing?.forEach(e => existingIds.add(e.drive_file_id))
            }
            const toProcess = allFiles.filter(f => !existingIds.has(f.id))
            driveSkipped = allFiles.length - toProcess.length

            // Process up to 20 new files
            const batch = toProcess.slice(0, 20)
            for (const file of batch) {
              const r = await processFile(file.id, account.id, account.company_name)
              if (r.success) driveProcessed++
            }
          }
        }

        // 3. Parallel queries for all data (AFTER Drive scan so new docs are included)
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
        if (driveProcessed > 0 || driveSkipped > 0) {
          lines.push(`Drive scan: ${driveProcessed} new files processed, ${driveSkipped} already in system`)
        } else if (!account.drive_folder_id) {
          lines.push("Drive scan: SKIPPED (no drive_folder_id)")
        }
        lines.push(`Visible (${visibleDocs.length}):`)

        for (const d of visibleDocs) {
          lines.push(`  ${d.document_type_name}`)
        }
        lines.push(`Hidden: ${hiddenIds.length} docs`)
        if (missingTypes.length > 0) {
          lines.push(`Not in system: ${missingTypes.join(", ")}`)
        }

        // --- SIGN DOCUMENTS ---
        // Auto-create OA if missing (all data available from account + contact)
        let oaData = oaRes.data
        let oaCreated = false
        if (!oaData && primaryContact) {
          const entityType = account.entity_type?.toLowerCase().includes("multi") ? "MMLLC" : "SMLLC"
          const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const token = `${companySlug}-oa-${new Date().getFullYear()}`
          const today = new Date().toISOString().slice(0, 10)
          const { data: newOa } = await supabaseAdmin
            .from("oa_agreements")
            .insert({
              token,
              account_id: account.id,
              contact_id: primaryContact.id,
              company_name: account.company_name,
              state_of_formation: account.state_of_formation || "Wyoming",
              formation_date: account.formation_date || today,
              ein_number: account.ein_number || null,
              entity_type: entityType,
              manager_name: primaryContact.full_name,
              member_name: primaryContact.full_name,
              member_email: primaryContact.email || null,
              effective_date: today,
              business_purpose: "any and all lawful business activities",
              initial_contribution: "$0.00",
              fiscal_year_end: "December 31",
              accounting_method: "Cash",
              duration: "Perpetual",
              principal_address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
              language: "en",
              status: "draft",
            })
            .select("id, token, status, access_code, signed_at")
            .single()
          if (newOa) {
            oaData = { status: newOa.status, signed_at: newOa.signed_at }
            oaCreated = true
            logAction({ action_type: "create", table_name: "oa_agreements", record_id: newOa.id, account_id: account.id, summary: `Auto-created OA for ${account.company_name} (legacy onboard)` })
          }
        }

        lines.push("")
        lines.push("--- SIGN DOCUMENTS ---")

        // OA status
        if (oaData) {
          const s = oaData.status === "signed" ? "Signed" : `Awaiting signature (${oaData.status})`
          lines.push(`  OA: ${s}${oaCreated ? " -- AUTO-CREATED" : ""}`)
        } else {
          lines.push("  OA: Cannot create (no contact linked)")
          issues.push("Cannot create OA -- no contact linked to account")
        }

        // Lease status — auto-create if missing from both formal records AND Drive
        let leaseData = leaseRes.data
        let leaseCreated = false
        const hasLeaseDriveDoc = docs.find(d => d.document_type_name === "Office Lease" && d.drive_link)
        if (!leaseData && !hasLeaseDriveDoc && primaryContact) {
          // Auto-assign next available suite number
          const { data: lastLeases } = await supabaseAdmin
            .from("lease_agreements")
            .select("suite_number")
            .order("suite_number", { ascending: false })
            .limit(1)
          let assignedSuite = "3D-101"
          if (lastLeases?.length) {
            const lastNum = parseInt(lastLeases[0].suite_number.replace("3D-", ""), 10)
            assignedSuite = `3D-${(lastNum + 1).toString().padStart(3, "0")}`
          }

          const year = new Date().getFullYear()
          const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const leaseToken = `${companySlug}-${year}`
          const today = new Date().toISOString().slice(0, 10)
          const lang = primaryContact.email ? "en" : "en"

          const { data: newLease } = await supabaseAdmin
            .from("lease_agreements")
            .insert({
              token: leaseToken,
              account_id: account.id,
              contact_id: primaryContact.id,
              tenant_company: account.company_name,
              tenant_contact_name: primaryContact.full_name,
              tenant_email: primaryContact.email,
              suite_number: assignedSuite,
              premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
              effective_date: today,
              term_start_date: today,
              term_end_date: `${year}-12-31`,
              contract_year: year,
              term_months: 12,
              monthly_rent: 100,
              yearly_rent: 1200,
              security_deposit: 150,
              square_feet: 120,
              status: "draft",
              language: lang,
            })
            .select("id, token, status, suite_number, signed_at")
            .single()
          if (newLease) {
            leaseData = { status: newLease.status, suite_number: newLease.suite_number, signed_at: newLease.signed_at }
            leaseCreated = true
            logAction({ action_type: "create", table_name: "lease_agreements", record_id: newLease.id, account_id: account.id, summary: `Auto-created lease for ${account.company_name} Suite ${assignedSuite} (legacy onboard)` })
          }
        }

        if (leaseData) {
          const s = leaseData.status === "signed" ? "Signed" : `Awaiting signature (${leaseData.status})`
          lines.push(`  Lease: ${s}${leaseData.suite_number ? ` -- Suite ${leaseData.suite_number}` : ""}${leaseCreated ? " -- AUTO-CREATED" : ""}`)
        } else if (hasLeaseDriveDoc) {
          lines.push("  Lease: Signed (detected from Drive)")
        } else {
          lines.push("  Lease: Cannot create (no contact linked)")
          issues.push("Cannot create lease -- no contact linked to account")
        }

        // SS-4 status: skip if EIN exists (already obtained)
        if (account.ein_number) {
          // EIN already obtained, SS-4 is irrelevant for signing
          const hasSs4Doc = docs.find(d => d.document_type_name === "Form SS-4" && d.drive_link)
          if (ss4Res.data) {
            lines.push(`  SS-4: ${ss4Res.data.status === "signed" ? "Signed" : ss4Res.data.status}`)
          } else if (hasSs4Doc) {
            lines.push("  SS-4: N/A (EIN already obtained)")
          } else {
            lines.push("  SS-4: N/A (EIN already obtained)")
          }
        } else if (ss4Res.data) {
          lines.push(`  SS-4: ${ss4Res.data.status === "signed" ? "Signed" : `Awaiting signature (${ss4Res.data.status})`}`)
        } else {
          lines.push("  SS-4: Not found -- create with ss4_create if EIN needed")
          issues.push("No SS-4 and no EIN -- create SS-4 with ss4_create")
        }

        // --- SERVICES (auto-create missing SDs) ---
        checksTotal++
        const existingTypes = new Set(sds.map(s => s.service_type))
        const createdSDs: string[] = []
        const bundle = (account as Record<string, unknown>).services_bundle as string[] | null

        // Auto-create Company Formation SD (completed) if formation_date exists
        if (account.formation_date && !existingTypes.has("Company Formation")) {
          const { data: newSD } = await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "Company Formation", pipeline: "Company Formation",
            service_name: `Company Formation -- ${account.company_name}`,
            stage: "Closing", stage_order: 6, status: "completed",
            start_date: account.formation_date, assigned_to: "Luca",
            notes: "Legacy onboard - formation already completed",
            stage_history: [{ to_stage: "Closing", to_order: 6, notes: "Legacy - already formed", advanced_at: new Date().toISOString() }],
          }).select("id").single()
          if (newSD) { createdSDs.push("Company Formation (completed)"); existingTypes.add("Company Formation") }
        }

        // Auto-create EIN SD (completed) if ein_number exists
        if (account.ein_number && !existingTypes.has("EIN")) {
          const { data: newSD } = await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "EIN", pipeline: "EIN",
            service_name: `EIN -- ${account.company_name}`,
            stage: "EIN Received", stage_order: 4, status: "completed",
            start_date: account.formation_date || new Date().toISOString().slice(0, 10), assigned_to: "Luca",
            notes: `Legacy onboard - EIN ${account.ein_number} already obtained`,
            stage_history: [{ to_stage: "EIN Received", to_order: 4, notes: "Legacy - EIN already obtained", advanced_at: new Date().toISOString() }],
          }).select("id").single()
          if (newSD) { createdSDs.push("EIN (completed)"); existingTypes.add("EIN") }
        }

        // Auto-create Annual Renewal SD (active) if services_bundle includes State Renewal
        if (bundle?.some(s => s.toLowerCase().includes("renewal") || s.toLowerCase().includes("state")) && !existingTypes.has("Annual Renewal")) {
          const { data: newSD } = await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "Annual Renewal",
            service_name: `Annual Renewal -- ${account.company_name}`,
            status: "active", start_date: new Date().toISOString().slice(0, 10), assigned_to: "Luca",
            notes: "Legacy onboard - annual renewal service",
          }).select("id").single()
          if (newSD) { createdSDs.push("Annual Renewal (active)"); existingTypes.add("Annual Renewal") }
        }

        // Re-query SDs after creation
        const { data: finalSDs } = await supabaseAdmin.from("service_deliveries")
          .select("id, service_name, service_type, stage, status")
          .eq("account_id", account_id).in("status", ["active", "completed"])

        lines.push("")
        lines.push("--- SERVICES ---")
        if (createdSDs.length > 0) {
          lines.push(`Auto-created: ${createdSDs.join(", ")}`)
        }
        const allSDs = finalSDs ?? []
        if (allSDs.length > 0) {
          checksPassed++
          lines.push(`Service deliveries: ${allSDs.length}`)
          for (const sd of allSDs) {
            lines.push(`  ${sd.service_name ?? sd.service_type} -- ${sd.stage ?? "no stage"} (${sd.status})`)
          }
        } else {
          lines.push("No services -- portal Services page will be EMPTY")
          issues.push("No service deliveries")
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
          // Not a blocker for portal access — just informational
        }

        // --- DEADLINES (auto-create if missing) ---
        checksTotal++
        const createdDeadlines: string[] = []
        const existingDeadlineTypes = new Set(deadlines.map(d => d.deadline_type))

        if (account.formation_date && account.state_of_formation) {
          const formDate = new Date(account.formation_date)
          const formMonth = formDate.getMonth() // 0-indexed
          const formDay = formDate.getDate()
          const nextYear = new Date().getFullYear() + 1
          const state = account.state_of_formation
          const llcType = account.entity_type?.toLowerCase().includes("multi") ? "MMLLC" : "SMLLC"

          // Annual Report deadline
          if (!existingDeadlineTypes.has("Annual Report")) {
            // Wyoming: 1st day of anniversary month. Florida: May 1. NM: no report.
            let arDue: string | null = null
            if (state === "Wyoming") arDue = `${nextYear}-${String(formMonth + 1).padStart(2, "0")}-01`
            else if (state === "Florida") arDue = `${nextYear}-05-01`

            if (arDue) {
              await supabaseAdmin.from("deadlines").insert({
                account_id: account.id, deadline_type: "Annual Report", due_date: arDue,
                status: "Pending", state, year: nextYear, llc_type: llcType, assigned_to: "Luca",
                deadline_record: `${account.company_name} - Annual Report ${nextYear}`,
                notes: "Legacy onboard",
              })
              createdDeadlines.push(`Annual Report ${arDue}`)
            }
          }

          // RA Renewal deadline
          if (!existingDeadlineTypes.has("RA Renewal")) {
            const raDue = `${nextYear}-${String(formMonth + 1).padStart(2, "0")}-${String(formDay).padStart(2, "0")}`
            await supabaseAdmin.from("deadlines").insert({
              account_id: account.id, deadline_type: "RA Renewal", due_date: raDue,
              status: "Pending", state, year: nextYear, llc_type: llcType, assigned_to: "Luca",
              deadline_record: `${account.company_name} - RA Renewal ${nextYear}`,
              notes: "Legacy onboard",
            })
            createdDeadlines.push(`RA Renewal ${raDue}`)
          }
        }

        // Re-query deadlines
        const { data: finalDeadlines } = await supabaseAdmin.from("deadlines")
          .select("id, deadline_type, due_date, status")
          .eq("account_id", account_id)

        lines.push("")
        lines.push("--- DEADLINES ---")
        if (createdDeadlines.length > 0) {
          lines.push(`Auto-created: ${createdDeadlines.join(", ")}`)
        }
        const allDeadlines = finalDeadlines ?? []
        const pendingDeadlines = allDeadlines.filter(d => d.status === "Pending")
        const overdueDeadlines = allDeadlines.filter(d => d.status === "Overdue")
        if (allDeadlines.length > 0) {
          checksPassed++
          lines.push(`${pendingDeadlines.length} pending, ${overdueDeadlines.length} overdue`)
          for (const d of [...overdueDeadlines, ...pendingDeadlines].slice(0, 5)) {
            lines.push(`  ${d.deadline_type}: ${d.due_date} (${d.status})`)
          }
        } else {
          lines.push("None")
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
          summary: `Legacy portal onboard: ${account.company_name} -- ${driveProcessed} new from Drive, ${visibleDocs.length} docs visible, readiness ${checksPassed}/${checksTotal}`,
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
