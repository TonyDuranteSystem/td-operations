import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PORTAL_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"
import { collectFilesRecursive, processFile } from "@/lib/mcp/tools/doc"
import { buildTransitionWelcomeEmail } from "@/lib/mcp/tools/offers"

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

// TD office addresses = CMRA clients
const TD_ADDRESS_PATTERNS = [
  "ulmerton",
  "gulf blvd",
  "indian shores",
  "park blvd",
]

function isTDAddress(address: string | null): boolean {
  if (!address) return false
  const lower = address.toLowerCase()
  return TD_ADDRESS_PATTERNS.some(p => lower.includes(p))
}

function isCurrentTDAddress(address: string | null): boolean {
  if (!address) return false
  return address.toLowerCase().includes("ulmerton")
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
    `Prepare a legacy client for portal access. Fully automated end-to-end:

1. Scans Google Drive for unprocessed files and processes them (OCR + classify)
2. Sets portal_visible on documents (allowed types visible, rest hidden)
3. Auto-creates OA (English, draft) if missing
4. Auto-creates Lease (auto-assign suite) if missing and client has TD address
5. Auto-creates missing service deliveries (Formation, EIN, Annual Renewal, CMRA, Tax Return 2025)
6. Auto-creates deadlines (Annual Report, RA Renewal by state rules)
7. Creates portal account (auth user + contact/account flags)
8. Generates the welcome email HTML for review -- DOES NOT SEND

Returns: full report + email HTML. Review the email, then call gmail_send to deliver it.

For Client accounts with TD addresses (Ulmerton/Gulf/Park) only.
One-Time accounts, non-TD addresses, and missing data are FLAGGED for manual review.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
    },
    async ({ account_id }) => {
      try {
        // ─── 1. GET ACCOUNT ───
        const { data: account } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, drive_folder_id, portal_account, portal_tier, services_bundle, account_type, installment_1_amount, installment_2_amount, notes")
          .eq("id", account_id)
          .single()

        if (!account) return { content: [{ type: "text" as const, text: "Account not found" }] }

        // ─── 2. PRE-FLIGHT CHECKS ───
        const flags: string[] = []

        // Check account type
        if (account.account_type === "One-Time") {
          flags.push("FLAG: One-Time account -- needs manual review (no auto-processing)")
          return { content: [{ type: "text" as const, text: `${account.company_name}\n\n${flags.join("\n")}\n\nOne-Time clients are flagged for individual review. Use this tool only for Client (annual) accounts.` }] }
        }

        // Check TD address
        if (!isTDAddress(account.physical_address)) {
          flags.push(`FLAG: Non-TD address (${account.physical_address || "NULL"}) -- check annual report for real address`)
          return { content: [{ type: "text" as const, text: `${account.company_name}\n\n${flags.join("\n")}\n\nOnly Client accounts with TD addresses (Ulmerton/Gulf/Park) can be auto-processed. This account needs manual address verification first.` }] }
        }

        // ─── 3. GET CONTACT (center of everything) ───
        const { data: contactLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id, role, ownership_pct, contact:contacts(id, full_name, email, phone, language, itin_number)")
          .eq("account_id", account_id)

        if (!contactLinks?.length) {
          return { content: [{ type: "text" as const, text: `${account.company_name}\n\nBLOCKER: No contact linked to account. Cannot proceed.` }] }
        }

        const primaryLink = contactLinks[0]
        const contact = primaryLink.contact as unknown as {
          id: string; full_name: string; email: string; phone: string;
          language: string | null; itin_number: string | null
        }

        if (!contact?.email) {
          return { content: [{ type: "text" as const, text: `${account.company_name}\n\nBLOCKER: Contact ${contact?.full_name || "unknown"} has no email. Cannot create portal account.` }] }
        }

        // Determine language: contacts.language, default Italian (KB rule 66c1e6fa)
        const lang: "en" | "it" = contact.language?.toLowerCase().startsWith("en") ? "en" : "it"

        // ─── 4. CHECK IF ALREADY DONE ───
        if (account.portal_account) {
          return { content: [{ type: "text" as const, text: `${account.company_name} -- portal already set up (portal_account=true). Skipping.` }] }
        }

        // Check if auth user already exists
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        const existingAuth = (authUsers?.users ?? []).find(u => u.email === contact.email)
        if (existingAuth) {
          flags.push(`NOTE: Auth user already exists for ${contact.email} -- will skip portal_create_user`)
        }

        // ─── 5. SCAN DRIVE ───
        const lines: string[] = [`== LEGACY PORTAL ONBOARD: ${account.company_name} ==`, ""]
        let driveProcessed = 0
        let driveSkipped = 0
        if (account.drive_folder_id) {
          const allFiles = await collectFilesRecursive(account.drive_folder_id, 3)
          if (allFiles.length > 0) {
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
            for (const file of toProcess.slice(0, 20)) {
              const r = await processFile(file.id, account.id, account.company_name)
              if (r.success) driveProcessed++
            }
          }
          lines.push(`Drive: ${driveProcessed} new files processed, ${driveSkipped} already in system`)
        } else {
          lines.push("Drive: no drive_folder_id linked")
          flags.push("FLAG: No Drive folder linked")
        }

        // ─── 6. SET PORTAL_VISIBLE ON DOCUMENTS ───
        const { data: docs } = await supabaseAdmin.from("documents")
          .select("id, file_name, document_type_name, portal_visible, drive_link")
          .eq("account_id", account_id)
          .order("processed_at", { ascending: false })

        const allDocs = docs ?? []
        const allowedIds: string[] = []
        const hiddenIds: string[] = []
        const seenTypes = new Set<string>()

        for (const doc of allDocs) {
          const typeName = doc.document_type_name ?? ""
          if (PORTAL_VISIBLE_DOC_TYPES.includes(typeName) && !seenTypes.has(typeName)) {
            seenTypes.add(typeName)
            allowedIds.push(doc.id)
          } else {
            hiddenIds.push(doc.id)
          }
        }

        if (allowedIds.length > 0) await supabaseAdmin.from("documents").update({ portal_visible: true }).in("id", allowedIds)
        if (hiddenIds.length > 0) await supabaseAdmin.from("documents").update({ portal_visible: false }).in("id", hiddenIds)

        const visibleDocs = allDocs.filter(d => allowedIds.includes(d.id))
        lines.push(`Documents: ${visibleDocs.length} visible, ${hiddenIds.length} hidden`)
        for (const d of visibleDocs) lines.push(`  ${d.document_type_name}`)

        // ─── 7. AUTO-CREATE OA ───
        const pendingDocs: string[] = []
        const { data: existingOA } = await supabaseAdmin.from("oa_agreements")
          .select("id, status").eq("account_id", account_id).maybeSingle()

        let oaStatus = ""
        if (existingOA) {
          oaStatus = existingOA.status === "signed" ? "Signed" : `Exists (${existingOA.status})`
          if (existingOA.status !== "signed") pendingDocs.push("Operating Agreement")
        } else {
          const entityType = account.entity_type?.toLowerCase().includes("multi") ? "MMLLC" : "SMLLC"
          const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const token = `${companySlug}-oa-${new Date().getFullYear()}`
          const today = new Date().toISOString().slice(0, 10)
          const { data: newOa } = await supabaseAdmin.from("oa_agreements").insert({
            token, account_id: account.id, contact_id: contact.id,
            company_name: account.company_name,
            state_of_formation: account.state_of_formation || "Wyoming",
            formation_date: account.formation_date || today,
            ein_number: account.ein_number || null,
            entity_type: entityType, manager_name: contact.full_name,
            member_name: contact.full_name, member_email: contact.email,
            effective_date: today,
            business_purpose: "any and all lawful business activities",
            initial_contribution: "$0.00", fiscal_year_end: "December 31",
            accounting_method: "Cash", duration: "Perpetual",
            principal_address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
            language: "en", status: "draft",
          }).select("id").single()
          if (newOa) {
            oaStatus = "AUTO-CREATED (draft)"
            pendingDocs.push("Operating Agreement")
            logAction({ action_type: "create", table_name: "oa_agreements", record_id: newOa.id, account_id: account.id, summary: `Auto-created OA for ${account.company_name} (legacy onboard)` })
          } else {
            oaStatus = "FAILED to create"
            flags.push("ERROR: OA creation failed")
          }
        }
        lines.push(`OA: ${oaStatus}`)

        // ─── 8. AUTO-CREATE LEASE (only if TD address and no existing lease or Drive doc) ───
        const { data: existingLease } = await supabaseAdmin.from("lease_agreements")
          .select("id, status, suite_number").eq("account_id", account_id).maybeSingle()
        const hasLeaseDriveDoc = allDocs.find(d => d.document_type_name === "Office Lease" && d.drive_link)

        let leaseStatus = ""
        if (existingLease) {
          leaseStatus = existingLease.status === "signed" ? `Signed (Suite ${existingLease.suite_number})` : `Exists (${existingLease.status}, Suite ${existingLease.suite_number})`
          if (existingLease.status !== "signed") pendingDocs.push("Lease Agreement")
        } else if (hasLeaseDriveDoc) {
          leaseStatus = "Signed (detected from Drive)"
        } else {
          // Auto-assign next suite
          const { data: lastLeases } = await supabaseAdmin.from("lease_agreements")
            .select("suite_number").order("suite_number", { ascending: false }).limit(1)
          let assignedSuite = "3D-101"
          if (lastLeases?.length) {
            const lastNum = parseInt(lastLeases[0].suite_number.replace("3D-", ""), 10)
            assignedSuite = `3D-${(lastNum + 1).toString().padStart(3, "0")}`
          }
          const year = new Date().getFullYear()
          const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const today = new Date().toISOString().slice(0, 10)
          const { data: newLease } = await supabaseAdmin.from("lease_agreements").insert({
            token: `${companySlug}-${year}`, account_id: account.id, contact_id: contact.id,
            tenant_company: account.company_name, tenant_contact_name: contact.full_name,
            tenant_email: contact.email, suite_number: assignedSuite,
            premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
            effective_date: today, term_start_date: today, term_end_date: `${year}-12-31`,
            contract_year: year, term_months: 12, monthly_rent: 100, yearly_rent: 1200,
            security_deposit: 150, square_feet: 120, status: "draft", language: "en",
          }).select("id, suite_number").single()
          if (newLease) {
            leaseStatus = `AUTO-CREATED (draft, Suite ${newLease.suite_number})`
            pendingDocs.push("Lease Agreement")
            logAction({ action_type: "create", table_name: "lease_agreements", record_id: newLease.id, account_id: account.id, summary: `Auto-created lease for ${account.company_name} Suite ${newLease.suite_number} (legacy onboard)` })
          } else {
            leaseStatus = "FAILED to create"
            flags.push("ERROR: Lease creation failed")
          }
        }
        lines.push(`Lease: ${leaseStatus}`)

        // ─── 9. AUTO-CREATE RENEWAL MSA ───
        const { data: existingMSA } = await supabaseAdmin.from("offers")
          .select("id, token, status").eq("account_id", account_id).eq("contract_type", "renewal").maybeSingle()

        let msaStatus = ""
        if (existingMSA) {
          msaStatus = `Exists (${existingMSA.status}, token: ${existingMSA.token})`
          if (existingMSA.status !== "signed" && existingMSA.status !== "completed") pendingDocs.push("Contratto Annuale")
        } else if (account.installment_1_amount) {
          // Create renewal MSA with installment amounts from account
          const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const year = new Date().getFullYear()
          const token = `renewal-${companySlug}-${year}`
          const today = new Date().toISOString().slice(0, 10)
          const { data: newMSA } = await supabaseAdmin.from("offers").insert({
            token, account_id: account.id, client_name: contact.full_name,
            client_email: contact.email, language: lang, contract_type: "renewal",
            payment_type: "bank_transfer", status: "draft", offer_date: today,
            effective_date: `${year}-01-01`,
            services: [{ name: "Annual LLC Management", price: (account.installment_1_amount || 0) + (account.installment_2_amount || 0), description: "Annual management including RA, Annual Report, CMRA, Tax Return, Client Portal" }],
            cost_summary: [
              { label: "First Installment (January)", items: [{ name: "Annual Management", price: `$${account.installment_1_amount?.toLocaleString() || "1,000"}` }], total: `$${account.installment_1_amount?.toLocaleString() || "1,000"}` },
              { label: "Second Installment (June)", items: [{ name: "Annual Management", price: `$${account.installment_2_amount?.toLocaleString() || "1,000"}` }], total: `$${account.installment_2_amount?.toLocaleString() || "1,000"}` },
            ],
          }).select("id, token").single()
          if (newMSA) {
            msaStatus = `AUTO-CREATED (draft, token: ${newMSA.token})`
            pendingDocs.push(lang === "it" ? "Contratto di Servizio Annuale" : "Annual Service Agreement")
            logAction({ action_type: "create", table_name: "offers", record_id: newMSA.id, account_id: account.id, summary: `Auto-created renewal MSA for ${account.company_name} (legacy onboard)` })
          } else {
            msaStatus = "FAILED to create"
            flags.push("ERROR: Renewal MSA creation failed")
          }
        } else {
          msaStatus = "SKIPPED -- no installment amounts on account"
          flags.push("FLAG: Missing installment amounts -- cannot create Renewal MSA. Set installment_1_amount and installment_2_amount on account first.")
        }
        lines.push(`Renewal MSA: ${msaStatus}`)

        // ─── 10. AUTO-CREATE SERVICE DELIVERIES ───
        const { data: existingSDs } = await supabaseAdmin.from("service_deliveries")
          .select("id, service_type, status").eq("account_id", account_id)
        const existingSDTypes = new Set((existingSDs ?? []).map(s => s.service_type))
        const createdSDs: string[] = []

        // Company Formation (completed)
        if (account.formation_date && !existingSDTypes.has("Company Formation")) {
          await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "Company Formation", pipeline: "Company Formation",
            service_name: `Company Formation -- ${account.company_name}`,
            stage: "Closing", stage_order: 6, status: "completed",
            start_date: account.formation_date, assigned_to: "Luca",
            notes: "Legacy onboard", stage_history: [{ to_stage: "Closing", to_order: 6, notes: "Legacy", advanced_at: new Date().toISOString() }],
          })
          createdSDs.push("Company Formation (completed)")
        }

        // EIN (completed)
        if (account.ein_number && !existingSDTypes.has("EIN")) {
          await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "EIN", pipeline: "EIN",
            service_name: `EIN -- ${account.company_name}`,
            stage: "EIN Received", stage_order: 4, status: "completed",
            start_date: account.formation_date || new Date().toISOString().slice(0, 10), assigned_to: "Luca",
            notes: `Legacy onboard - EIN ${account.ein_number}`, stage_history: [{ to_stage: "EIN Received", to_order: 4, notes: "Legacy", advanced_at: new Date().toISOString() }],
          })
          createdSDs.push("EIN (completed)")
        }

        // Annual Renewal (active)
        if (!existingSDTypes.has("Annual Renewal")) {
          await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "Annual Renewal",
            service_name: `Annual Renewal -- ${account.company_name}`,
            status: "active", start_date: new Date().toISOString().slice(0, 10), assigned_to: "Luca",
            notes: "Legacy onboard",
          })
          createdSDs.push("Annual Renewal (active)")
        }

        // CMRA (active) - all TD address clients get CMRA
        if (!existingSDTypes.has("CMRA Mailing Address")) {
          await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "CMRA Mailing Address",
            service_name: `CMRA -- ${account.company_name}`,
            status: "active", start_date: new Date().toISOString().slice(0, 10), assigned_to: "Luca",
            notes: `Legacy onboard - address: ${account.physical_address}`,
          })
          createdSDs.push("CMRA (active)")
        }

        // Tax Return 2025 (active) - if formed before 2026
        if (account.formation_date && account.formation_date < "2026-01-01") {
          const { data: existingTR } = await supabaseAdmin.from("tax_returns")
            .select("id").eq("company_name", account.company_name).eq("tax_year", 2025).maybeSingle()
          if (!existingTR) {
            flags.push("FLAG: No 2025 tax return record -- needs manual review with Antonio/Luca")
          }
        }

        // ITIN (completed) if contact has itin_number
        if (contact.itin_number && !existingSDTypes.has("ITIN")) {
          await supabaseAdmin.from("service_deliveries").insert({
            account_id: account.id, service_type: "ITIN",
            service_name: `ITIN -- ${account.company_name}`,
            status: "completed", start_date: new Date().toISOString().slice(0, 10), assigned_to: "Luca",
            notes: `Legacy onboard - ITIN ${contact.itin_number}`,
          })
          createdSDs.push("ITIN (completed)")
        }

        if (createdSDs.length > 0) lines.push(`SDs created: ${createdSDs.join(", ")}`)

        // ─── 11. AUTO-CREATE DEADLINES ───
        const { data: existingDeadlines } = await supabaseAdmin.from("deadlines")
          .select("deadline_type").eq("account_id", account_id)
        const existingDLTypes = new Set((existingDeadlines ?? []).map(d => d.deadline_type))
        const createdDeadlines: string[] = []

        if (account.formation_date && account.state_of_formation) {
          const formDate = new Date(account.formation_date)
          const formMonth = formDate.getMonth()
          const formDay = formDate.getDate()
          const nextYear = new Date().getFullYear() + 1
          const state = account.state_of_formation
          const llcType = account.entity_type?.toLowerCase().includes("multi") ? "MMLLC" : "SMLLC"

          // Annual Report
          if (!existingDLTypes.has("Annual Report")) {
            let arDue: string | null = null
            if (state === "Wyoming") arDue = `${nextYear}-${String(formMonth + 1).padStart(2, "0")}-01`
            else if (state === "Florida") arDue = `${nextYear}-05-01`
            // NM has no annual report
            if (arDue) {
              await supabaseAdmin.from("deadlines").insert({
                account_id: account.id, deadline_type: "Annual Report", due_date: arDue,
                status: "Pending", state, year: nextYear, llc_type: llcType, assigned_to: "Luca",
                deadline_record: `${account.company_name} - Annual Report ${nextYear}`, notes: "Legacy onboard",
              })
              createdDeadlines.push(`Annual Report ${arDue}`)
            }
          }

          // RA Renewal
          if (!existingDLTypes.has("RA Renewal")) {
            const raDue = `${nextYear}-${String(formMonth + 1).padStart(2, "0")}-${String(formDay).padStart(2, "0")}`
            await supabaseAdmin.from("deadlines").insert({
              account_id: account.id, deadline_type: "RA Renewal", due_date: raDue,
              status: "Pending", state, year: nextYear, llc_type: llcType, assigned_to: "Luca",
              deadline_record: `${account.company_name} - RA Renewal ${nextYear}`, notes: "Legacy onboard",
            })
            createdDeadlines.push(`RA Renewal ${raDue}`)
          }
        }

        if (createdDeadlines.length > 0) lines.push(`Deadlines created: ${createdDeadlines.join(", ")}`)

        // ─── 12. OLD ADDRESS FLAG ───
        if (isTDAddress(account.physical_address) && !isCurrentTDAddress(account.physical_address)) {
          flags.push(`FLAG: Old TD address (${account.physical_address}) -- will need Form 8822-B to change to Ulmerton (do later)`)
        }

        // ─── 13. CREATE PORTAL ACCOUNT ───
        let tempPassword = ""
        let portalCreated = false
        if (!existingAuth) {
          tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
          const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email: contact.email, password: tempPassword, email_confirm: true,
            app_metadata: { role: "client", contact_id: contact.id },
            user_metadata: { full_name: contact.full_name, must_change_password: true },
          })
          if (createError || !newUser) {
            flags.push(`ERROR: Portal account creation failed: ${createError?.message || "unknown"}`)
          } else {
            portalCreated = true
            logAction({ action_type: "create", table_name: "auth.users", record_id: newUser.user.id, account_id: account.id, summary: `Portal user created: ${contact.full_name} (${contact.email})` })
          }
        } else {
          lines.push(`Portal account: already exists (${contact.email})`)
        }

        // ─── 14. UPDATE CRM FLAGS ───
        await supabaseAdmin.from("accounts").update({
          portal_account: true, portal_tier: "active",
          portal_created_date: new Date().toISOString().split("T")[0],
          notes: (account.notes || "") + `\n${new Date().toISOString().split("T")[0]}: Portal legacy onboard completed [PORTAL_LEGACY_ONBOARD]`,
        }).eq("id", account.id)

        await supabaseAdmin.from("contacts").update({
          portal_tier: "active",
        }).eq("id", contact.id)

        // ─── 15. GENERATE EMAIL (DO NOT SEND) ───
        const portalUrl = `${PORTAL_BASE_URL}/portal/login`
        const firstName = contact.full_name.split(" ")[0]
        const emailHtml = buildTransitionWelcomeEmail(
          firstName, contact.email, tempPassword || "[existing password]",
          portalUrl, account.company_name, lang, pendingDocs,
        )
        const emailSubject = lang === "it"
          ? `Il Tuo Nuovo Portale Clienti -- Tony Durante LLC`
          : `Your New Client Portal -- Tony Durante LLC`

        // ─── 16. BUILD REPORT ───
        lines.push("")
        if (portalCreated) {
          lines.push(`Portal account: CREATED (${contact.email}, password: ${tempPassword})`)
        }
        lines.push(`Portal tier: active`)
        lines.push(`Language: ${lang}`)
        lines.push(`Pending docs to sign: ${pendingDocs.length > 0 ? pendingDocs.join(", ") : "none"}`)

        if (flags.length > 0) {
          lines.push("")
          lines.push("--- FLAGS ---")
          for (const f of flags) lines.push(`  ${f}`)
        }

        lines.push("")
        lines.push("--- EMAIL READY FOR REVIEW ---")
        lines.push(`To: ${contact.email}`)
        lines.push(`Subject: ${emailSubject}`)
        lines.push(`Language: ${lang}`)
        lines.push("")
        lines.push("Review the email, then send with:")
        lines.push(`gmail_send(to: "${contact.email}", subject: "${emailSubject}", body_html: [the HTML below], account_id: "${account.id}", contact_id: "${contact.id}", tag: "portal-legacy-onboard")`)

        logAction({
          action_type: "update", table_name: "accounts", record_id: account.id, account_id: account.id,
          summary: `Legacy portal onboard complete: ${account.company_name} -- ${visibleDocs.length} docs, ${createdSDs.length} SDs, OA: ${oaStatus}, Lease: ${leaseStatus}, MSA: ${msaStatus}`,
        })

        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            { type: "text" as const, text: "\n\n--- EMAIL HTML ---\n\n" + emailHtml },
          ],
        }
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

        if (account_id && !directEmail) {
          let targetContactId = contact_id
          if (!targetContactId) {
            const { data: links } = await supabaseAdmin
              .from("account_contacts").select("contact_id").eq("account_id", account_id).limit(1)
            if (!links?.length) return { content: [{ type: "text" as const, text: "No contacts linked to this account" }] }
            targetContactId = links[0].contact_id
          }
          const { data: contactData } = await supabaseAdmin
            .from("contacts").select("full_name, email").eq("id", targetContactId).single()
          if (!contactData?.email) return { content: [{ type: "text" as const, text: "Contact has no email address" }] }
          userEmail = contactData.email
          userName = contactData.full_name
        }

        if (!userEmail) return { content: [{ type: "text" as const, text: "Either account_id or email is required" }] }

        const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
        const existingUser = (existingList?.users ?? []).find(u => u.email === userEmail)
        if (existingUser) return { content: [{ type: "text" as const, text: `Portal user already exists: ${userEmail}` }] }

        const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

        let resolvedContactId = contact_id
        if (!resolvedContactId && account_id) {
          const { data: links } = await supabaseAdmin
            .from("account_contacts").select("contact_id").eq("account_id", account_id).limit(1)
          resolvedContactId = links?.[0]?.contact_id || undefined
        }

        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email: userEmail, password: tempPassword, email_confirm: true,
          app_metadata: { role: "client", ...(resolvedContactId ? { contact_id: resolvedContactId } : {}) },
          user_metadata: { full_name: userName, must_change_password: true },
        })

        if (createError) return { content: [{ type: "text" as const, text: createError.message }] }

        let portalTier = "lead"
        if (account_id) {
          const { data: offers } = await supabaseAdmin.from("offers").select("status")
            .eq("account_id", account_id).in("status", ["completed", "signed"]).limit(1)
          if (offers?.length) portalTier = "onboarding"

          if (portalTier === "lead") {
            const { data: existingSds } = await supabaseAdmin.from("service_deliveries").select("id").eq("account_id", account_id).limit(1)
            const { data: ss4s } = await supabaseAdmin.from("ss4_applications").select("id").eq("account_id", account_id).limit(1)
            if (existingSds?.length || ss4s?.length) portalTier = "active"
          }

          await supabaseAdmin.from("accounts").update({
            portal_account: true, portal_tier: portalTier,
            portal_created_date: new Date().toISOString().split("T")[0],
          }).eq("id", account_id)
        }

        if (resolvedContactId) {
          await supabaseAdmin.from("contacts").update({ portal_tier: portalTier }).eq("id", resolvedContactId)
        }

        logAction({
          action_type: "create", table_name: "auth.users",
          record_id: newUser.user.id, account_id: account_id || undefined,
          summary: `Portal user created: ${userName} (${userEmail})`,
        })

        return {
          content: [{
            type: "text" as const,
            text: [
              `Portal account created`,
              `${userName} (${userEmail})`,
              `Temp password: ${tempPassword}`,
              `Login: ${PORTAL_BASE_URL}/portal/login`,
              ``,
              `Client will be asked to change password on first login.`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}
