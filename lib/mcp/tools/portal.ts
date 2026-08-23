import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { PORTAL_BASE_URL, APP_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"
import { updateAccount } from "@/lib/operations/account"
import { createSD } from "@/lib/operations/service-delivery"
import { syncTier } from "@/lib/operations/sync-tier"
import { collectFilesRecursive, processFile } from "@/lib/mcp/tools/doc"
import { buildTransitionWelcomeEmail } from "@/lib/mcp/tools/offers"
import { gmailPost, getGmailAttachment } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import type { MailingAddressRow } from "@/lib/addresses"
import { LLC_MANAGEMENT_BUNDLE_TYPES } from "@/lib/services"
import { formatMcpChatSenderLabel } from "@/lib/portal/chat-sender-name"
import { contactThreadOrFilter, multiMemberAccountIds } from "@/lib/portal/thread-scope"
import { isContactLinkedToAccount, resolveAdminReplyContact } from "@/lib/portal/admin-send-scope"
import { downloadFileBinaryForSend } from "@/lib/google-drive"
import { buildChatAttachmentPath } from "@/lib/portal/chat-attachment-path"
import { guessMimeType } from "@/lib/mcp/tools/drive"

// Document types allowed to be visible in the client portal Documents tab
// Document types visible to clients in the portal (by type name)
const PORTAL_VISIBLE_DOC_TYPES = [
  "Form SS-4",
  "Articles of Organization",
  "Office Lease",
  "Lease Agreement",
  "Operating Agreement",
  "EIN Letter (IRS)",
  "Form 8832",
  "ITIN Letter",
  "Signed Contract",
]

// Entire categories visible to clients (3=Tax, 5=Correspondence)
const PORTAL_VISIBLE_CATEGORIES = [3, 5]

// TD office addresses = CMRA clients
const TD_ADDRESS_PATTERNS = [
  "ulmerton",
  "gulf blvd",
  "indian shores",
  "park blvd",
]

function isTDAddress(address: string | null, mailingRow?: Pick<MailingAddressRow, 'is_td_provided'> | null): boolean {
  if (mailingRow != null) return mailingRow.is_td_provided === true
  if (!address) return false
  const lower = address.toLowerCase()
  return TD_ADDRESS_PATTERNS.some(p => lower.includes(p))
}

function isCurrentTDAddress(address: string | null, mailingRow?: Pick<MailingAddressRow, 'is_td_provided'> | null): boolean {
  if (mailingRow != null) return mailingRow.is_td_provided === true
  if (!address) return false
  return address.toLowerCase().includes("ulmerton")
}

// Account fields required for a complete portal experience
const _REQUIRED_ACCOUNT_FIELDS = [
  "ein_number",
  "formation_date",
  "entity_type",
  "state_of_formation",
] as const

export function registerPortalTools(server: McpServer) {
  // ─── Helper: process a single account for portal transition ───
  // Returns per-account report lines, flags, and pending docs
  async function processAccountForTransition(
    account: {
      id: string; company_name: string; entity_type: string | null; member_structure: string | null; state_of_formation: string | null
      ein_number: string | null; formation_date: string | null; onboarding_date: string | null; status: string; physical_address: string | null
      mailing_address?: Pick<MailingAddressRow, 'is_td_provided'> | null
      drive_folder_id: string | null; portal_account: boolean | null; portal_tier: string | null
      services_bundle: string[] | null; account_type: string | null
      installment_1_amount: number | null; installment_2_amount: number | null; notes: string | null
    },
    contact: { id: string; full_name: string; email: string; phone: string; language: string | null; itin_number: string | null },
    lang: "en" | "it",
  ): Promise<{ lines: string[]; flags: string[]; pendingDocs: string[]; skipped: boolean }> {
    const lines: string[] = [`── ${account.company_name} ──`]
    const flags: string[] = []
    const pendingDocs: string[] = []
    const isOneTime = account.account_type === "One-Time"

    // Pre-flight: TD address check (Client accounts only)
    if (!isOneTime && !isTDAddress(account.physical_address, account.mailing_address)) {
      flags.push(`FLAG: Non-TD address (${account.physical_address || "NULL"}) -- needs manual address verification`)
      lines.push("SKIPPED: Non-TD address")
      return { lines, flags, pendingDocs, skipped: true }
    }

    // Already done?
    if (account.portal_account) {
      lines.push("Already set up (portal_account=true). Skipping data setup.")
      return { lines, flags, pendingDocs, skipped: true }
    }

    // ─── SCAN DRIVE ───
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

    // ─── SET PORTAL_VISIBLE ON DOCUMENTS ───
    const { data: docs } = await supabaseAdmin.from("documents")
      .select("id, file_name, document_type_name, category, portal_visible, drive_link")
      .eq("account_id", account.id)
      .order("processed_at", { ascending: false })

    const allDocs = docs ?? []
    const allowedIds: string[] = []
    const hiddenIds: string[] = []
    const seenTypes = new Set<string>()

    for (const doc of allDocs) {
      const typeName = doc.document_type_name ?? ""
      const docCategory = doc.category as number | null
      const isVisibleByType = PORTAL_VISIBLE_DOC_TYPES.includes(typeName) && !seenTypes.has(typeName)
      const isVisibleByCategory = docCategory != null && PORTAL_VISIBLE_CATEGORIES.includes(docCategory)
      if (isVisibleByType || isVisibleByCategory) {
        if (isVisibleByType) seenTypes.add(typeName)
        allowedIds.push(doc.id)
      } else {
        hiddenIds.push(doc.id)
      }
    }

    const { updateDocumentsBulk } = await import("@/lib/operations/document")
    if (allowedIds.length > 0) {
      await updateDocumentsBulk({
        ids: allowedIds,
        patch: { portal_visible: true },
        actor: "claude.ai",
        summary: `Portal transition — ${allowedIds.length} docs set visible`,
        account_id: account.id,
      })
    }
    if (hiddenIds.length > 0) {
      await updateDocumentsBulk({
        ids: hiddenIds,
        patch: { portal_visible: false },
        actor: "claude.ai",
        summary: `Portal transition — ${hiddenIds.length} docs hidden`,
        account_id: account.id,
      })
    }

    const visibleDocs = allDocs.filter(d => allowedIds.includes(d.id))
    lines.push(`Documents: ${visibleDocs.length} visible, ${hiddenIds.length} hidden`)
    for (const d of visibleDocs) lines.push(`  ${d.document_type_name}`)

    // ─── AUTO-CREATE OA, LEASE, RENEWAL MSA (Client accounts only) ───
    let oaStatus = "N/A"
    let leaseStatus = "N/A"
    let msaStatus = "N/A"

    if (isOneTime) {
      lines.push("OA: SKIPPED (One-Time account)")
      lines.push("Lease: SKIPPED (One-Time account)")
      lines.push("Renewal MSA: SKIPPED (One-Time account)")
    }

    if (!isOneTime) {
      const { data: existingOA } = await supabaseAdmin.from("oa_agreements")
        .select("id, status").eq("account_id", account.id).maybeSingle()

      oaStatus = ""
      if (existingOA) {
        oaStatus = existingOA.status === "signed" ? "Signed" : `Exists (${existingOA.status})`
        if (existingOA.status !== "signed") pendingDocs.push("Operating Agreement")
      } else {
        const entityType = account.member_structure === "multi_member" ? "MMLLC" : "SMLLC"
        const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        const token = `${companySlug}-oa-${new Date().getFullYear()}`
        const today = new Date().toISOString().slice(0, 10)
        // Who the document names as Manager/Member — resolved PER ACCOUNT
        // from the members table's flagged signer, never from `contact` (the
        // one contact resolved once for the whole batch this function runs
        // over — reusing it here would stamp the same person's name across
        // every different company that contact happens to be linked to).
        // Dev job 9ad76300-6181-4250-a1de-c77f37933f82.
        const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
        const signerResolution = await resolveAccountSigner(account.id)
        if (signerResolution.outcome !== "resolved") {
          oaStatus = "FAILED to create"
          flags.push(`ERROR: OA creation failed — ${signerResolution.message}`)
        } else {
          const signerContact = signerResolution.contact
          const { data: newOa } = await supabaseAdmin.from("oa_agreements").insert({
            token, account_id: account.id, contact_id: signerContact.id,
            company_name: account.company_name,
            state_of_formation: account.state_of_formation || "Wyoming",
            formation_date: account.formation_date || today,
            ein_number: account.ein_number || null,
            entity_type: entityType, manager_name: signerContact.full_name,
            member_name: signerContact.full_name, member_email: signerContact.email,
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
      }
      lines.push(`OA: ${oaStatus}`)

      // LEASE
      const { data: existingLease } = await supabaseAdmin.from("lease_agreements")
        .select("id, status, suite_number").eq("account_id", account.id).maybeSingle()
      const hasLeaseDriveDoc = allDocs.find(d => d.document_type_name === "Office Lease" && d.drive_link)

      leaseStatus = ""
      if (existingLease) {
        leaseStatus = existingLease.status === "signed" ? `Signed (Suite ${existingLease.suite_number})` : `Exists (${existingLease.status}, Suite ${existingLease.suite_number})`
        if (existingLease.status !== "signed") pendingDocs.push("Lease Agreement")
      } else if (hasLeaseDriveDoc) {
        leaseStatus = "Signed (detected from Drive)"
      } else {
        // No explicit contact_id — createLease resolves the tenant/signer
        // itself from the account's members table (is_signer flag), not from
        // `contact` (the generic first-linked-contact used elsewhere in this
        // flow for OA/portal purposes, which is the wrong source for a
        // Multi-Member LLC's signer).
        const { createLease } = await import("@/lib/operations/lease")
        const leaseResult = await createLease({
          account_id: account.id,
          actor: "claude.ai:portal-transition",
          summary: `Auto-created lease for ${account.company_name} (legacy onboard)`,
          language: "en",
        })
        if (leaseResult.success && leaseResult.lease) {
          leaseStatus = `AUTO-CREATED (draft, Suite ${leaseResult.lease.suite_number})`
          pendingDocs.push("Lease Agreement")
        } else {
          leaseStatus = "FAILED to create"
          flags.push(`ERROR: Lease creation failed — ${leaseResult.error || "unknown"}`)
        }
      }
      lines.push(`Lease: ${leaseStatus}`)

      // ANNUAL AGREEMENT
      const agreementYear = new Date().getUTCFullYear()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existingMSA } = await (supabaseAdmin as any).from("annual_agreements")
        .select("id, token, status").eq("account_id", account.id).eq("agreement_year", agreementYear).maybeSingle() as { data: { id: string; token: string; status: string } | null }

      msaStatus = ""
      if (existingMSA) {
        msaStatus = `Exists (${existingMSA.status}, token: ${existingMSA.token})`
        if (existingMSA.status !== "signed" && existingMSA.status !== "completed") pendingDocs.push("Contratto Annuale")
      } else if (account.installment_1_amount) {
        // Year 1 guard + September rule (P5/C4 KB rules)
        const tdStartDate = account.onboarding_date || account.formation_date
        const tdStartYear = tdStartDate ? new Date(tdStartDate).getUTCFullYear() : null
        const tdStartMonth = tdStartDate ? new Date(tdStartDate).getUTCMonth() + 1 : null

        if (tdStartYear === agreementYear) {
          msaStatus = `SKIPPED — Year 1 client (onboarding: ${tdStartDate})`
        } else {
          const skipJanuary = tdStartYear === agreementYear - 1 && tdStartMonth !== null && tdStartMonth >= 9
          // Legacy clients (started before this year) have already been billed outside the portal.
          // Create their current-year MSA as completed so it never appears as pending in the portal.
          const isLegacyTransition = tdStartYear !== null && tdStartYear < agreementYear
          const msaInitialStatus = isLegacyTransition ? "completed" : "draft"
          const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const token = `renewal-${companySlug}-${agreementYear}`
          const today = new Date().toISOString().slice(0, 10)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: newMSA, error: msaError } = await (supabaseAdmin as any).from("annual_agreements").insert({
            token, account_id: account.id, agreement_year: agreementYear,
            client_name: contact.full_name, client_email: contact.email,
            language: lang, payment_type: "bank_transfer", status: msaInitialStatus, offer_date: today,
            effective_date: `${agreementYear}-01-01`,
            skip_january: skipJanuary || isLegacyTransition,
            bundled_pipelines: [...LLC_MANAGEMENT_BUNDLE_TYPES],
            services: [{ name: "Annual LLC Management", price: (account.installment_1_amount || 0) + (account.installment_2_amount || 0), description: "Annual management including RA, Annual Report, CMRA, Tax Return, Client Portal" }],
            cost_summary: skipJanuary
              ? [
                  { label: "First Installment (June)", items: [{ name: "Annual Management", price: `$${account.installment_1_amount?.toLocaleString() || "1,000"}` }], total: `$${account.installment_1_amount?.toLocaleString() || "1,000"}` },
                  { label: "Second Installment (June — Year 3+)", items: [{ name: "Annual Management", price: `$${account.installment_2_amount?.toLocaleString() || "1,000"}` }], total: `$${account.installment_2_amount?.toLocaleString() || "1,000"}` },
                ]
              : [
                  { label: "First Installment (January)", items: [{ name: "Annual Management", price: `$${account.installment_1_amount?.toLocaleString() || "1,000"}` }], total: `$${account.installment_1_amount?.toLocaleString() || "1,000"}` },
                  { label: "Second Installment (June)", items: [{ name: "Annual Management", price: `$${account.installment_2_amount?.toLocaleString() || "1,000"}` }], total: `$${account.installment_2_amount?.toLocaleString() || "1,000"}` },
                ],
          }).select("id, token").single() as { data: { id: string; token: string } | null; error: { message: string; code: string } | null }
          if (newMSA) {
            msaStatus = `AUTO-CREATED${isLegacyTransition ? " (legacy, completed — no signature required)" : skipJanuary ? " (Sep-rule, skip January)" : ""} (${msaInitialStatus}, token: ${newMSA.token})`
            if (!isLegacyTransition) pendingDocs.push(lang === "it" ? "Contratto di Servizio Annuale" : "Annual Service Agreement")
            logAction({ action_type: "create", table_name: "annual_agreements", record_id: newMSA.id, account_id: account.id, summary: `Auto-created annual agreement for ${account.company_name} (legacy onboard)` })
          } else {
            msaStatus = `FAILED to create${msaError ? `: ${msaError.message} (${msaError.code})` : ""}`
            flags.push(`ERROR: Annual Agreement creation failed${msaError ? ` — ${msaError.message}` : ""}`)
          }
        }
      } else {
        msaStatus = "SKIPPED -- no installment amounts on account"
        flags.push("FLAG: Missing installment amounts -- cannot create Annual Agreement. Set installment_1_amount and installment_2_amount on account first.")
      }
      lines.push(`Annual Agreement: ${msaStatus}`)
    }

    // ─── AUTO-CREATE SERVICE DELIVERIES ───
    // CANONICAL LEGACY-ONBOARD SD SET (mirrored in
    // app/api/portal/admin/transition/route.ts): Company Formation, EIN,
    // CMRA Mailing Address, Tax Return, ITIN, State RA Renewal, State Annual
    // Report. Annual Renewal is NOT an SD — renewals flow through
    // annual_agreements (MSA signing + installment invoices), not
    // service_deliveries. Divergence vs Site F (admin/transition route): that
    // site additionally gates CMRA on isTDAddress; this site creates CMRA for
    // all non-one-time accounts. Sites E and F should otherwise produce
    // identical SD sets.
    const { data: existingSDs } = await supabaseAdmin.from("service_deliveries")
      .select("id, service_type, status").eq("account_id", account.id)
    const existingSDTypes = new Set((existingSDs ?? []).map(s => s.service_type))
    const createdSDs: string[] = []

    if (account.formation_date && !existingSDTypes.has("Company Formation")) {
      await createSD({
        service_type: "Company Formation",
        service_name: `Company Formation -- ${account.company_name}`,
        account_id: account.id,
        target_stage: "Closing",
        target_stage_order: 6,
        status: "completed",
        start_date: account.formation_date,
        notes: "Legacy onboard",
      })
      createdSDs.push("Company Formation (completed)")
    }

    if (account.ein_number && !existingSDTypes.has("EIN")) {
      await createSD({
        service_type: "EIN",
        service_name: `EIN -- ${account.company_name}`,
        account_id: account.id,
        target_stage: "EIN Received",
        target_stage_order: 4,
        status: "completed",
        start_date: account.formation_date || new Date().toISOString().slice(0, 10),
        notes: `Legacy onboard - EIN ${account.ein_number}`,
      })
      createdSDs.push("EIN (completed)")
    }

    // Annual Renewal SD intentionally NOT created here — the annual renewal
    // flow is MSA signing (January cron creates renewal offer; signing triggers
    // first installment invoice). No SD tracks the renewal itself.

    if (!isOneTime && !existingSDTypes.has("CMRA Mailing Address")) {
      await createSD({
        service_type: "CMRA Mailing Address",
        service_name: `CMRA -- ${account.company_name}`,
        account_id: account.id,
        // Phase 4 Step 3: legacy onboard means the lease is signed and the
        // address is in service. Explicit stage avoids createSD's first-stage
        // default ("Lease Created").
        target_stage: "CMRA Active",
        target_stage_order: 3,
        status: "active",
        start_date: new Date().toISOString().slice(0, 10),
        notes: `Legacy onboard - address: ${account.physical_address}`,
      })
      createdSDs.push("CMRA (active)")
    }

    // Tax Return SD (Client accounts only, formed before 2026)
    if (!isOneTime && account.formation_date && account.formation_date < "2026-01-01" && !existingSDTypes.has("Tax Return")) {
      const { data: existingTR } = await supabaseAdmin.from("tax_returns")
        .select("id, data_received").eq("account_id", account.id).eq("tax_year", 2025).maybeSingle()

      const hasTaxRecord = !!existingTR
      const trStage = hasTaxRecord ? "Data Received" : "1st Installment Paid"
      const trStageOrder = hasTaxRecord ? 3 : 1

      await createSD({
        service_type: "Tax Return",
        service_name: `Tax Return -- ${account.company_name}`,
        account_id: account.id,
        target_stage: trStage,
        target_stage_order: trStageOrder,
        status: "active",
        start_date: new Date().toISOString().slice(0, 10),
        notes: hasTaxRecord
          ? `Legacy onboard - 2025 tax return record exists (${existingTR?.id})`
          : "Legacy onboard - no 2025 tax return record yet; wizard needed",
      })
      createdSDs.push(`Tax Return (${trStage})`)

      if (!hasTaxRecord) {
        flags.push("FLAG: Tax wizard needed -- no 2025 tax_returns record. Run tax_form_create separately.")
      }
    }

    if (contact.itin_number && !existingSDTypes.has("ITIN")) {
      await createSD({
        service_type: "ITIN",
        service_name: `ITIN -- ${contact.full_name || account.company_name}`,
        account_id: account.id,
        // Phase 4 Step 3: legacy onboard with ITIN already issued. Explicit
        // stage avoids createSD's first-stage default ("Data Collection").
        target_stage: "ITIN Approved",
        target_stage_order: 8,
        status: "completed",
        start_date: new Date().toISOString().slice(0, 10),
        notes: `Legacy onboard - ITIN ${contact.itin_number}`,
      })
      createdSDs.push("ITIN (completed)")
    }

    // State RA Renewal SD (Client accounts only)
    if (!isOneTime && !existingSDTypes.has("State RA Renewal")) {
      await createSD({
        service_type: "State RA Renewal",
        service_name: `State RA Renewal -- ${account.company_name}`,
        account_id: account.id,
        target_stage: "Upcoming",
        target_stage_order: 1,
        status: "active",
        start_date: new Date().toISOString().slice(0, 10),
        notes: "Legacy onboard",
      })
      createdSDs.push("State RA Renewal (Upcoming)")
    }

    // State Annual Report SD (Client accounts only)
    if (!isOneTime && !existingSDTypes.has("State Annual Report")) {
      await createSD({
        service_type: "State Annual Report",
        service_name: `State Annual Report -- ${account.company_name}`,
        account_id: account.id,
        target_stage: "Upcoming",
        target_stage_order: 1,
        status: "active",
        start_date: new Date().toISOString().slice(0, 10),
        notes: "Legacy onboard",
      })
      createdSDs.push("State Annual Report (Upcoming)")
    }

    if (createdSDs.length > 0) lines.push(`SDs created: ${createdSDs.join(", ")}`)

    // ─── AUTO-CREATE DEADLINES (Client accounts only) ───
    const createdDeadlines: string[] = []
    if (!isOneTime) {
      const { data: existingDeadlines } = await supabaseAdmin.from("deadlines")
        .select("deadline_type").eq("account_id", account.id)
      const existingDLTypes = new Set((existingDeadlines ?? []).map(d => d.deadline_type))

      if (account.formation_date && account.state_of_formation) {
        const formDate = new Date(account.formation_date)
        const formMonth = formDate.getMonth()
        const formDay = formDate.getDate()
        const nextYear = new Date().getFullYear() + 1
        const state = account.state_of_formation
        const llcType = account.member_structure === "multi_member" ? "MMLLC" : "SMLLC"

        if (!existingDLTypes.has("Annual Report")) {
          let arDue: string | null = null
          if (state === "Wyoming") arDue = `${nextYear}-${String(formMonth + 1).padStart(2, "0")}-01`
          else if (state === "Florida") arDue = `${nextYear}-05-01`
          else if (state === "Delaware") arDue = `${nextYear}-06-01`
          if (arDue) {
            await supabaseAdmin.from("deadlines").insert({
              account_id: account.id, deadline_type: "Annual Report", due_date: arDue,
              status: "Pending", state, year: nextYear, llc_type: llcType, assigned_to: "Luca",
              deadline_record: `${account.company_name} - Annual Report ${nextYear}`, notes: "Legacy onboard",
            })
            createdDeadlines.push(`Annual Report ${arDue}`)
          }
        }

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
    }
    if (createdDeadlines.length > 0) lines.push(`Deadlines created: ${createdDeadlines.join(", ")}`)

    // OLD ADDRESS FLAG
    if (isTDAddress(account.physical_address, account.mailing_address) && !isCurrentTDAddress(account.physical_address, account.mailing_address)) {
      flags.push(`FLAG: Old TD address (${account.physical_address}) -- will need Form 8822-B to change to Ulmerton (do later)`)
    }

    // UPDATE ACCOUNT FLAGS — portal_account + dated setup note (tier set via syncTier by caller)
    await updateAccount({
      id: account.id,
      patch: {
        portal_account: true,
        portal_created_date: new Date().toISOString().split("T")[0],
        notes: (account.notes || "") + `\n${new Date().toISOString().split("T")[0]}: Portal transition setup completed. [PORTAL_TRANSITION_SETUP]`,
      },
      actor: "claude.ai",
      summary: `Legacy portal onboard: ${account.company_name} -- ${visibleDocs.length} docs, ${createdSDs.length} SDs, OA: ${oaStatus}, Lease: ${leaseStatus}, MSA: ${msaStatus}`,
    })

    return { lines, flags, pendingDocs, skipped: false }
  }

  // Send the transition welcome email to a contact using the safeSend pattern
  // (CLAUDE.md: Send Operations — safeSend Pattern MANDATORY, line 119). Called
  // ONCE per contact (even if they own multiple LLCs). Returns a status object
  // instead of throwing, so batch callers can log-and-continue. Idempotency:
  // skips the send if contacts.portal_email_sent_at is already set and
  // forceResend is false.
  async function sendTransitionWelcome(
    contact: { id: string; full_name: string; email: string },
    primaryAccount: { id: string; company_name: string },
    tempPassword: string,
    lang: "en" | "it",
    pendingDocs: string[],
    forceResend = false,
  ): Promise<{ sent: boolean; subject: string; alreadySent?: boolean; error?: string; warnings?: string[] }> {
    const portalUrl = `${PORTAL_BASE_URL}/portal/login`
    const firstName = contact.full_name.split(" ")[0]
    const emailHtml = buildTransitionWelcomeEmail(
      firstName, contact.email, tempPassword || "[existing password]",
      portalUrl, primaryAccount.company_name, lang, pendingDocs,
    )
    const subject = lang === "it"
      ? `Il Tuo Nuovo Portale Clienti -- Tony Durante LLC`
      : `Your New Client Portal -- Tony Durante LLC`

    // RFC 2047 subject encoding (CLAUDE.md line 144: MANDATORY for raw MIME)
    const hasNonAscii = /[^\x00-\x7F]/.test(subject)
    const encodedSubject = hasNonAscii
      ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
      : subject

    const fromEmail = "support@tonydurante.us"
    const boundary = `boundary_${Date.now()}`
    const plainText = lang === "it"
      ? `Ciao ${firstName}, benvenuto nel tuo nuovo portale clienti Tony Durante LLC. Accedi: ${portalUrl} — Email: ${contact.email} — Password temporanea: ${tempPassword}`
      : `Hi ${firstName}, welcome to your new Tony Durante LLC client portal. Log in: ${portalUrl} — Email: ${contact.email} — Temporary password: ${tempPassword}`

    const mimeParts = [
      [
        `From: Tony Durante LLC <${fromEmail}>`,
        `To: ${contact.email}`,
        `Subject: ${encodedSubject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ].join("\r\n"),
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(plainText).toString("base64"),
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(emailHtml).toString("base64"),
      "",
      `--${boundary}--`,
    ]
    const encodedRaw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

    try {
      const result = await safeSend<{ id: string; threadId: string }>({
        idempotencyCheck: async () => {
          if (forceResend) return null
          const { data: existingContact } = await supabaseAdmin
            .from("contacts")
            .select("portal_email_sent_at")
            .eq("id", contact.id)
            .single()
          if (existingContact?.portal_email_sent_at) {
            return {
              alreadySent: true,
              message: `Welcome email already sent to ${contact.email} on ${existingContact.portal_email_sent_at}`,
            }
          }
          return null
        },

        sendFn: async () => {
          return await gmailPost("/messages/send", { raw: encodedRaw }) as { id: string; threadId: string }
        },

        postSendSteps: [
          {
            name: "update_contact_email_tracking",
            fn: async () => {
              // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
              await supabaseAdmin.from("contacts").update({
                portal_email_sent_at: new Date().toISOString().split("T")[0],
                portal_email_template: lang === "it" ? "it-branded-v2" : "en-branded-v2",
              }).eq("id", contact.id)
            },
          },
          {
            name: "log_action",
            fn: async () => {
              logAction({
                action_type: "send", table_name: "contacts", record_id: contact.id,
                account_id: primaryAccount.id,
                summary: `Portal welcome email sent to ${contact.email} (${lang})`,
              })
            },
          },
        ],
      })

      if (result.alreadySent) {
        return { sent: false, subject, alreadySent: true, error: result.idempotencyMessage }
      }

      const warnings = result.steps.filter(s => s.status === "error").map(s => `${s.step}: ${s.error}`)
      return { sent: true, subject, warnings: warnings.length ? warnings : undefined }
    } catch (err) {
      // safeSend.sendFn threw — the actual gmail send failed
      return {
        sent: false,
        subject,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  server.tool(
    "portal_transition_setup",
    `Prepare a legacy client for portal access. Processes ALL active accounts for the contact in one shot.

Per account:
1. Scans Google Drive for unprocessed files (OCR + classify)
2. Sets portal_visible on documents
3. Auto-creates OA, Lease, Renewal MSA if missing (Client accounts only)
4. Auto-creates service deliveries (Formation, EIN, Annual Renewal, CMRA, ITIN)
5. Auto-creates deadlines (Annual Report, RA Renewal by state rules)
6. Sets portal_account=true + portal_tier=active on the account

Once (across all accounts):
7. Creates auth user with full metadata (contact_id + account_ids)
8. Sets portal_tier=active on the contact
9. Generates welcome email HTML for review -- DOES NOT SEND

Pass any one account_id -- the tool finds the contact, then processes ALL their active accounts.
Returns: full report + email HTML. Review the email, then call gmail_send to deliver it.

BULK GUARD: requires i_understand_this_is_bulk=true on every call.`,
    {
      account_id: z.string().uuid().describe("Any CRM account UUID for this client — all active accounts for the same contact will be processed"),
      i_understand_this_is_bulk: z.boolean().describe("REQUIRED: explicit bulk-operation acknowledgment. Must be set to the literal boolean true. This tool processes ALL active accounts for the contact in one shot: Drive scan + document processing, OA + Lease + Renewal MSA creation, service deliveries, deadlines, auth user creation, portal_tier updates. The guard exists to prevent accidental multi-account cascade execution."),
    },
    async ({ account_id, i_understand_this_is_bulk }) => {
      try {
        // ─── BULK GUARD: Hard block unless caller explicitly acknowledges ───
        if (i_understand_this_is_bulk !== true) {
          return {
            content: [{
              type: "text" as const,
              text: "🛑 BLOCKED: portal_transition_setup is a multi-account cascade operation (Drive processing + document creation + service deliveries + deadlines + auth user creation + portal_tier updates across ALL active accounts for the contact). You must pass i_understand_this_is_bulk=true explicitly to acknowledge this before the tool will run. No fallback, no default — the flag must be the boolean true.",
            }],
          }
        }

        // ─── 1. RESOLVE CONTACT from the given account ───
        const { data: contactLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id, role, ownership_pct, contact:contacts(id, full_name, email, phone, language, itin_number)")
          .eq("account_id", account_id)

        if (!contactLinks?.length) {
          return { content: [{ type: "text" as const, text: "BLOCKER: No contact linked to this account. Cannot proceed." }] }
        }

        const primaryLink = contactLinks[0]
        const contact = primaryLink.contact as unknown as {
          id: string; full_name: string; email: string; phone: string;
          language: string | null; itin_number: string | null
        }

        if (!contact?.email) {
          return { content: [{ type: "text" as const, text: `BLOCKER: Contact ${contact?.full_name || "unknown"} has no email. Cannot create portal account.` }] }
        }

        // ─── 2. FIND ALL ACTIVE ACCOUNTS for this contact ───
        const { data: allAccountLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", contact.id)

        const allAccountIds = (allAccountLinks ?? []).map(l => l.account_id)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: allAccounts } = await (supabaseAdmin as any)
          .from("accounts")
          .select("id, company_name, entity_type, member_structure, state_of_formation, ein_number, formation_date, onboarding_date, status, physical_address, mailing_address:addresses!business_mailing_address_id(is_td_provided), drive_folder_id, portal_account, portal_tier, services_bundle, account_type, installment_1_amount, installment_2_amount, notes")
          .in("id", allAccountIds)
          .eq("status", "Active") as { data: Parameters<typeof processAccountForTransition>[0][] | null }

        const activeAccounts = allAccounts ?? []

        if (activeAccounts.length === 0) {
          return { content: [{ type: "text" as const, text: `No active accounts found for ${contact.full_name}. Nothing to process.` }] }
        }

        // Determine language
        const hasItalian = contact.language?.toLowerCase().startsWith("it") || contact.language === "Italian"
        const lang: "en" | "it" = hasItalian ? "it" : "en"

        // ─── 3. CHECK / CREATE AUTH USER (once) ───
        const existingAuth = contact.email ? await findAuthUserByEmail(contact.email) : null

        let tempPassword = ""
        let portalCreated = false
        const globalFlags: string[] = []

        if (!existingAuth) {
          tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
          const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email: contact.email, password: tempPassword, email_confirm: true,
            app_metadata: {
              role: "client",
              contact_id: contact.id,
              portal_tier: "active",
              account_ids: activeAccounts.map(a => a.id),
            },
            user_metadata: { full_name: contact.full_name, must_change_password: true },
          })
          if (createError || !newUser) {
            globalFlags.push(`ERROR: Portal account creation failed: ${createError?.message || "unknown"}`)
          } else {
            portalCreated = true
            logAction({ action_type: "create", table_name: "auth.users", record_id: newUser.user.id, account_id: account_id, summary: `Portal user created: ${contact.full_name} (${contact.email}) — ${activeAccounts.length} accounts` })
          }
        } else {
          // Repair existing auth user metadata
          await supabaseAdmin.auth.admin.updateUserById(existingAuth.id, {
            app_metadata: {
              ...existingAuth.app_metadata,
              role: "client",
              contact_id: contact.id,
              portal_tier: "active",
              account_ids: activeAccounts.map(a => a.id),
            },
          })
          globalFlags.push(`NOTE: Auth user already exists for ${contact.email} -- metadata repaired (account_ids synced)`)
        }

        // ─── 4. PROCESS EACH ACCOUNT ───
        const reportLines: string[] = [
          `== LEGACY PORTAL ONBOARD: ${contact.full_name} ==`,
          `Contact: ${contact.email}`,
          `Active accounts: ${activeAccounts.length} (${activeAccounts.map(a => a.company_name).join(", ")})`,
          "",
        ]
        const allPendingDocs: string[] = []

        for (const acct of activeAccounts) {
          const result = await processAccountForTransition(acct, contact, lang)
          reportLines.push(...result.lines)
          reportLines.push("")
          globalFlags.push(...result.flags)
          allPendingDocs.push(...result.pendingDocs)
          // Sync tier per account (handles account + contact recompute + auth metadata)
          await syncTier({ accountId: acct.id, newTier: 'active', reason: 'legacy portal transition' })
        }

        // ─── 5. BUILD SUMMARY ───
        reportLines.push("== SUMMARY ==")
        if (portalCreated) {
          reportLines.push(`Portal account: CREATED (${contact.email}, password: ${tempPassword})`)
        } else {
          reportLines.push(`Portal account: already existed (${contact.email}) -- metadata repaired`)
        }
        reportLines.push(`Portal tier: active`)
        reportLines.push(`Language: ${lang}`)
        reportLines.push(`Accounts processed: ${activeAccounts.length}`)
        reportLines.push(`Pending docs to sign: ${allPendingDocs.length > 0 ? allPendingDocs.join(", ") : "none"}`)

        if (globalFlags.length > 0) {
          reportLines.push("")
          reportLines.push("--- FLAGS ---")
          for (const f of globalFlags) reportLines.push(`  ${f}`)
        }

        // ─── 6. AUTO-SEND WELCOME EMAIL (log-and-continue on failure) ───
        const emailResult = await sendTransitionWelcome(
          contact, activeAccounts[0], tempPassword || "[existing password]",
          lang, allPendingDocs,
        )

        reportLines.push("")
        reportLines.push("--- WELCOME EMAIL ---")
        if (emailResult.sent) {
          reportLines.push(`✅ Sent to ${contact.email}`)
          reportLines.push(`Subject: ${emailResult.subject}`)
          reportLines.push(`Language: ${lang}`)
          if (emailResult.warnings?.length) {
            reportLines.push(`⚠️ Post-send warnings: ${emailResult.warnings.join("; ")}`)
            globalFlags.push(...emailResult.warnings.map(w => `WARN: Welcome email post-send for ${contact.email}: ${w}`))
          }
        } else if (emailResult.alreadySent) {
          reportLines.push(`⏭️  Skipped (already sent): ${contact.email}`)
          reportLines.push(`${emailResult.error}`)
        } else {
          reportLines.push(`❌ NOT sent to ${contact.email}`)
          reportLines.push(`Error: ${emailResult.error}`)
          reportLines.push(`Retry manually with gmail_send — template: ${lang === "it" ? "it-branded-v2" : "en-branded-v2"}`)
          globalFlags.push(`ERROR: Welcome email failed for ${contact.email}: ${emailResult.error}`)
        }

        // ─── 7. ADDITIONAL MEMBERS (Multi-Member LLC) ───
        // For each additional contact linked to this account, create their auth
        // user and send their welcome email. processAccountForTransition is NOT
        // re-run — account-level work (docs, SDs, notes) is already done above.
        const additionalLinks = contactLinks.slice(1)
        if (additionalLinks.length > 0) {
          reportLines.push("")
          reportLines.push("--- ADDITIONAL MEMBERS ---")
          for (const addLink of additionalLinks) {
            const addContact = addLink.contact as unknown as {
              id: string; full_name: string; email: string; language: string | null
            }
            if (!addContact?.email) {
              reportLines.push(`⚠️ ${addContact?.full_name || "Unknown"}: no email — skipped`)
              globalFlags.push(`SKIP: Additional contact ${addContact?.full_name || "unknown"} has no email`)
              continue
            }

            // Compute this contact's own account list for auth metadata
            const { data: addAccountLinks } = await supabaseAdmin
              .from("account_contacts")
              .select("account_id")
              .eq("contact_id", addContact.id)
            const addAccountIds = (addAccountLinks ?? []).map(l => l.account_id)

            const addLang: "en" | "it" = addContact.language?.toLowerCase().startsWith("it") || addContact.language === "Italian" ? "it" : "en"
            const existingAddAuth = await findAuthUserByEmail(addContact.email)

            if (!existingAddAuth) {
              const addTempPwd = `TD${Math.random().toString(36).slice(2, 10)}!`
              const { data: addUser, error: addErr } = await supabaseAdmin.auth.admin.createUser({
                email: addContact.email, password: addTempPwd, email_confirm: true,
                app_metadata: { role: "client", contact_id: addContact.id, portal_tier: "active", account_ids: addAccountIds },
                user_metadata: { full_name: addContact.full_name, must_change_password: true },
              })
              if (addErr || !addUser) {
                reportLines.push(`❌ ${addContact.full_name}: auth user creation failed — ${addErr?.message || "unknown"}`)
                globalFlags.push(`ERROR: Auth user creation failed for ${addContact.email}: ${addErr?.message || "unknown"}`)
                continue
              }
              logAction({ action_type: "create", table_name: "auth.users", record_id: addUser.user.id, account_id: account_id, summary: `Additional member portal user created: ${addContact.full_name} (${addContact.email})` })
              // syncTier already ran per-account in step 4 — contact tier is already active
              const addEmailResult = await sendTransitionWelcome(addContact, activeAccounts[0], addTempPwd, addLang, allPendingDocs)
              if (addEmailResult.sent) {
                reportLines.push(`✅ ${addContact.full_name} (${addContact.email}): auth user created, welcome email sent`)
              } else {
                reportLines.push(`⚠️ ${addContact.full_name} (${addContact.email}): auth user created, email failed — ${addEmailResult.error}`)
                globalFlags.push(`ERROR: Welcome email failed for additional member ${addContact.email}: ${addEmailResult.error}`)
              }
            } else {
              // Auth user already exists — repair metadata and attempt welcome email if not yet sent
              await supabaseAdmin.auth.admin.updateUserById(existingAddAuth.id, {
                app_metadata: { ...existingAddAuth.app_metadata, role: "client", contact_id: addContact.id, portal_tier: "active", account_ids: addAccountIds },
              })
              const addEmailResult = await sendTransitionWelcome(addContact, activeAccounts[0], "", addLang, allPendingDocs)
              if (addEmailResult.alreadySent) {
                reportLines.push(`⏭️ ${addContact.full_name} (${addContact.email}): auth user existed, welcome email already sent`)
              } else if (addEmailResult.sent) {
                reportLines.push(`✅ ${addContact.full_name} (${addContact.email}): auth user existed (metadata repaired), welcome email sent`)
              } else {
                reportLines.push(`⚠️ ${addContact.full_name} (${addContact.email}): auth user existed (metadata repaired), email failed — ${addEmailResult.error}`)
              }
              globalFlags.push(`NOTE: Auth user already existed for additional contact ${addContact.email} — metadata repaired`)
            }
          }
        }

        return {
          content: [
            { type: "text" as const, text: reportLines.join("\n") },
          ],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  server.tool(
    "portal_transition_batch",
    `Batch version of portal_transition_setup. Runs the full legacy-onboard pipeline for many accounts at once — sequentially, one contact at a time.

Input: array of account UUIDs. The tool groups accounts by their primary contact, so if two account IDs belong to the same person, that person gets ONE welcome email covering all their LLCs (matching portal_transition_setup semantics).

Per contact:
1. Resolves all active accounts linked to that contact (not just the input ones) — matches portal_transition_setup
2. Creates/repairs auth user + sets portal_tier=active on contact
3. For each active account: runs processAccountForTransition (Drive scan, doc visibility, OA/Lease/MSA creation, all service deliveries incl. Tax Return + State RA Renewal + State Annual Report, deadlines, account flags)
4. Auto-sends welcome email (log-and-continue on failure — flags set, next contact still processed)

Returns a per-contact status table. Does NOT abort on individual failures — one bad contact doesn't block the batch.

Use this for the 2026 legacy portal transition (159 clients). Run portal_transition_setup for single-contact ad-hoc runs.`,
    {
      account_ids: z.array(z.string().uuid()).min(1).describe("Array of CRM account UUIDs. Contacts are deduplicated automatically."),
    },
    async ({ account_ids }) => {
      const batchStart = Date.now()
      const perAccountResults: Array<{
        account_id: string
        company_name?: string
        contact_name?: string
        contact_email?: string
        status: "processed" | "skipped" | "blocked" | "error" | "grouped"
        detail: string
      }> = []

      try {
        // ─── 1. RESOLVE ALL INPUT ACCOUNTS → CONTACTS ───
        // Dedupe accounts first
        const uniqueAccountIds = Array.from(new Set(account_ids))

        const { data: allContactLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id, contact_id, contact:contacts(id, full_name, email, phone, language, itin_number)")
          .in("account_id", uniqueAccountIds)

        if (!allContactLinks?.length) {
          return { content: [{ type: "text" as const, text: "BLOCKER: No contacts linked to any of the provided accounts." }] }
        }

        // Group by contact_id — pick first contact per account
        const accountToContact = new Map<string, string>()
        const contactsById = new Map<string, { id: string; full_name: string; email: string; phone: string; language: string | null; itin_number: string | null }>()
        for (const link of allContactLinks) {
          if (!accountToContact.has(link.account_id)) {
            accountToContact.set(link.account_id, link.contact_id)
          }
          if (link.contact_id && !contactsById.has(link.contact_id)) {
            contactsById.set(link.contact_id, link.contact as unknown as { id: string; full_name: string; email: string; phone: string; language: string | null; itin_number: string | null })
          }
        }

        // Mark any input account with no contact as blocked
        for (const acctId of uniqueAccountIds) {
          if (!accountToContact.has(acctId)) {
            perAccountResults.push({ account_id: acctId, status: "blocked", detail: "No contact linked to this account" })
          }
        }

        // Build unique contact list from accounts that DID have a contact
        const uniqueContactIds = Array.from(new Set(Array.from(accountToContact.values())))

        // ─── 2. PROCESS EACH CONTACT SEQUENTIALLY ───
        const contactLines: string[] = []
        let contactsProcessed = 0
        let contactsFailed = 0

        for (const contactId of uniqueContactIds) {
          const contact = contactsById.get(contactId)
          if (!contact) {
            perAccountResults.push({ account_id: "(unknown)", status: "error", detail: `Contact ${contactId} not found` })
            contactsFailed++
            continue
          }

          if (!contact.email) {
            perAccountResults.push({
              account_id: "(all)",
              contact_name: contact.full_name,
              status: "blocked",
              detail: "Contact has no email — cannot create portal account",
            })
            contactsFailed++
            continue
          }

          try {
            // Find ALL active accounts for this contact (not just the input ones)
            const { data: allContactAccountLinks } = await supabaseAdmin
              .from("account_contacts")
              .select("account_id")
              .eq("contact_id", contact.id)
            const allContactAccountIds = (allContactAccountLinks ?? []).map(l => l.account_id)

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: activeAccounts } = await (supabaseAdmin as any)
              .from("accounts")
              .select("id, company_name, entity_type, member_structure, state_of_formation, ein_number, formation_date, onboarding_date, status, physical_address, mailing_address:addresses!business_mailing_address_id(is_td_provided), drive_folder_id, portal_account, portal_tier, services_bundle, account_type, installment_1_amount, installment_2_amount, notes")
              .in("id", allContactAccountIds)
              .eq("status", "Active") as { data: Parameters<typeof processAccountForTransition>[0][] | null }

            if (!activeAccounts?.length) {
              perAccountResults.push({
                account_id: "(all)",
                contact_name: contact.full_name,
                contact_email: contact.email,
                status: "skipped",
                detail: "No active accounts",
              })
              continue
            }

            const hasItalian = contact.language?.toLowerCase().startsWith("it") || contact.language === "Italian"
            const lang: "en" | "it" = hasItalian ? "it" : "en"

            // Auth user create/repair (same logic as portal_transition_setup)
            const existingAuth = contact.email ? await findAuthUserByEmail(contact.email) : null

            let tempPassword = ""
            if (!existingAuth) {
              tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
              const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
                email: contact.email, password: tempPassword, email_confirm: true,
                app_metadata: {
                  role: "client",
                  contact_id: contact.id,
                  portal_tier: "active",
                  account_ids: activeAccounts.map(a => a.id),
                },
                user_metadata: { full_name: contact.full_name, must_change_password: true },
              })
              if (createError || !newUser) {
                perAccountResults.push({
                  account_id: "(all)",
                  contact_name: contact.full_name,
                  contact_email: contact.email,
                  status: "error",
                  detail: `Portal account creation failed: ${createError?.message || "unknown"}`,
                })
                contactsFailed++
                continue
              }
              logAction({ action_type: "create", table_name: "auth.users", record_id: newUser.user.id, account_id: activeAccounts[0].id, summary: `Portal user created (batch): ${contact.full_name} (${contact.email}) — ${activeAccounts.length} accounts` })
            } else {
              await supabaseAdmin.auth.admin.updateUserById(existingAuth.id, {
                app_metadata: {
                  ...existingAuth.app_metadata,
                  role: "client",
                  contact_id: contact.id,
                  portal_tier: "active",
                  account_ids: activeAccounts.map(a => a.id),
                },
              })
            }

            // Process each active account
            const allPendingDocs: string[] = []
            const processedAccountIds: string[] = []

            for (const acct of activeAccounts) {
              try {
                const result = await processAccountForTransition(acct, contact, lang)
                allPendingDocs.push(...result.pendingDocs)
                processedAccountIds.push(acct.id)
                // Sync tier per account (handles account + contact recompute + auth metadata)
                await syncTier({ accountId: acct.id, newTier: 'active', reason: 'legacy portal transition' })

                perAccountResults.push({
                  account_id: acct.id,
                  company_name: acct.company_name,
                  contact_name: contact.full_name,
                  contact_email: contact.email,
                  status: result.skipped ? "skipped" : "processed",
                  detail: result.skipped
                    ? result.flags[0] || "skipped"
                    : `${result.lines.length} ops; ${result.flags.length} flag(s)`,
                })
              } catch (acctErr) {
                perAccountResults.push({
                  account_id: acct.id,
                  company_name: acct.company_name,
                  contact_name: contact.full_name,
                  contact_email: contact.email,
                  status: "error",
                  detail: acctErr instanceof Error ? acctErr.message : String(acctErr),
                })
              }
            }

            // Send welcome email ONCE per contact (log-and-continue)
            const emailResult = await sendTransitionWelcome(
              contact, activeAccounts[0], tempPassword || "[existing password]",
              lang, allPendingDocs,
            )

            contactsProcessed++
            let emailStatus: string
            if (emailResult.sent) {
              emailStatus = emailResult.warnings?.length ? `sent (warnings: ${emailResult.warnings.join("; ")})` : "sent"
            } else if (emailResult.alreadySent) {
              emailStatus = "skipped (already sent)"
            } else {
              emailStatus = `FAILED (${emailResult.error})`
            }
            contactLines.push(
              `✓ ${contact.full_name} (${contact.email}) — ${processedAccountIds.length}/${activeAccounts.length} accounts, email: ${emailStatus}`
            )
          } catch (contactErr) {
            contactsFailed++
            perAccountResults.push({
              account_id: "(all)",
              contact_name: contact.full_name,
              contact_email: contact.email,
              status: "error",
              detail: contactErr instanceof Error ? contactErr.message : String(contactErr),
            })
            contactLines.push(`✗ ${contact.full_name} (${contact.email}) — ERROR: ${contactErr instanceof Error ? contactErr.message : String(contactErr)}`)
          }
        }

        // ─── 3. BUILD SUMMARY ───
        const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1)
        const lines: string[] = [
          `== BATCH PORTAL TRANSITION ==`,
          `Input accounts: ${uniqueAccountIds.length}`,
          `Unique contacts: ${uniqueContactIds.length}`,
          `Contacts processed: ${contactsProcessed}`,
          `Contacts failed: ${contactsFailed}`,
          `Elapsed: ${elapsed}s`,
          "",
          "--- CONTACTS ---",
          ...contactLines,
          "",
          "--- PER-ACCOUNT RESULTS ---",
        ]
        for (const r of perAccountResults) {
          lines.push(
            `[${r.status.toUpperCase()}] ${r.company_name || r.account_id} — ${r.contact_name || "?"} (${r.contact_email || "?"}) — ${r.detail}`
          )
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Batch error: ${err instanceof Error ? err.message : String(err)}\n\nPartial results:\n${perAccountResults.map(r => `[${r.status}] ${r.account_id} — ${r.detail}`).join("\n")}`,
          }],
        }
      }
    }
  )

  server.tool(
    "portal_create_user",
    "Create a portal login for a client or partner. Creates a Supabase Auth user with client role, sets temp password, marks account as portal-enabled. Returns login URL + temp password. For LLC clients: pass account_id. For leads without account: pass email + full_name directly. For partners: set portal_role='partner' — auto-sets tier to active, generates referral_code, and sets referrer_type.",
    {
      account_id: z.string().uuid().optional().describe("CRM account UUID (for LLC clients)"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      email: z.string().optional().describe("Email address (for leads without account -- use instead of account_id)"),
      full_name: z.string().optional().describe("Full name (for leads without account)"),
      portal_role: z.enum(["client", "partner"]).optional().default("client").describe("Portal role: 'client' (default) or 'partner' (referrer portal with referral tracking)"),
    },
    async ({ account_id, contact_id, email: directEmail, full_name: directName, portal_role: portalRole }) => {
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

        const existingUser = await findAuthUserByEmail(userEmail)
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
          // Check account type — One-Time customers with paid deals go straight to active
          const { data: acctData } = await supabaseAdmin.from("accounts").select("account_type").eq("id", account_id).single()
          if (acctData?.account_type === "One-Time") {
            portalTier = "active"
          } else {
            const { data: offers } = await supabaseAdmin.from("offers").select("status, contract_type")
              .eq("account_id", account_id).in("status", ["completed", "signed"]).limit(1)
            if (offers?.length) {
              portalTier = offers[0].contract_type === "formation" ? "formation" : "onboarding"
            }
          }

          if (portalTier === "lead") {
            const { data: existingSds } = await supabaseAdmin.from("service_deliveries").select("id").eq("account_id", account_id).limit(1)
            const { data: ss4s } = await supabaseAdmin.from("ss4_applications").select("id").eq("account_id", account_id).limit(1)
            if (existingSds?.length || ss4s?.length) portalTier = "active"
          }

          await updateAccount({
            id: account_id,
            patch: {
              portal_account: true,
              portal_tier: portalTier,
              portal_created_date: new Date().toISOString().split("T")[0],
            },
            actor: "claude.ai",
            summary: `Portal user created (tier=${portalTier})`,
          })
        }

        if (resolvedContactId) {
          const contactUpdates: Record<string, unknown> = { portal_tier: portalTier }

          // Partner-specific setup
          if (portalRole === "partner") {
            contactUpdates.portal_role = "partner"
            contactUpdates.portal_tier = "active" // Partners always get active tier
            contactUpdates.referrer_type = "partner"
            portalTier = "active"
          }

          // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
          await supabaseAdmin.from("contacts").update(contactUpdates).eq("id", resolvedContactId)

          // Generate referral code for partners
          let referralCode: string | undefined
          if (portalRole === "partner") {
            const { generateReferralCode } = await import("@/lib/referral-utils")
            referralCode = await generateReferralCode(userName, supabaseAdmin)
            // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
            await supabaseAdmin.from("contacts").update({ referral_code: referralCode }).eq("id", resolvedContactId)
          }
        }

        // For partner referral code in response message
        let referralCode: string | undefined
        if (portalRole === "partner" && resolvedContactId) {
          const { data: codeData } = await supabaseAdmin.from("contacts").select("referral_code").eq("id", resolvedContactId).single()
          referralCode = codeData?.referral_code || undefined
        }

        logAction({
          action_type: "create", table_name: "auth.users",
          record_id: newUser.user.id, account_id: account_id || undefined,
          summary: `Portal user created: ${userName} (${userEmail})${portalRole === "partner" ? " [PARTNER]" : ""}. IMPORTANT: Credentials email NOT sent yet -- send via gmail_send then update contacts.portal_email_sent_at.`,
        })

        const lines = [
          `Portal account created${portalRole === "partner" ? " (Partner)" : ""}`,
          `${userName} (${userEmail})`,
          `Temp password: ${tempPassword}`,
          `Login: ${PORTAL_BASE_URL}/portal/login`,
        ]
        if (referralCode) {
          lines.push(``, `Referral code: ${referralCode}`, `Referral link: ${APP_BASE_URL}/r/${referralCode}`)
        }
        lines.push(
          ``,
          `${portalRole === "partner" ? "Partner" : "Client"} will be asked to change password on first login.`,
          ``,
          `IMPORTANT: Credentials email has NOT been sent yet.`,
          `After sending the email with gmail_send, you MUST update the contact:`,
          `crm_update_record(contacts, ${resolvedContactId || '<contact_id>'}, {portal_email_sent_at: '${new Date().toISOString().split("T")[0]}', portal_email_template: '<template_name>'})`,
        )

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_invoice_create ───────────────────────────────────────────

  server.tool(
    "portal_invoice_create",
    `Create a TD LLC invoice TO a client (writes to payments + client_expenses). The OFFICIAL invoicing system — use this instead of QB for new invoices.

Supports two scenarios:
- **Contact-level** (pass contact_id): For setup fees, ITIN, or any payment before an account exists. The contact is the center — they pay before any LLC is created.
- **Account-level** (pass account_id): For annual installments, recurring services on an existing LLC.
- Both can be provided (contact pays for a specific company).

Returns the created invoice with payment ID, number, total. The client sees this as an expense in their portal.

Workflow: portal_invoice_create -> portal_invoice_send (email with PDF) -> client pays -> mark as paid.
Or: portal_invoice_create(mark_as_paid=true) if already paid (invoices are receipts per rule P6).`,
    {
      contact_id: z.string().uuid().optional().describe("Contact UUID — invoice a person (setup fees, pre-account). At least one of contact_id or account_id required."),
      account_id: z.string().uuid().optional().describe("Account UUID — invoice a company (annual installments). At least one of contact_id or account_id required."),
      line_items: z.array(z.object({
        description: z.string().describe("Line item description"),
        unit_price: z.number().describe("Unit price"),
        quantity: z.number().optional().describe("Quantity (default 1)"),
      })).min(1).describe("Invoice line items"),
      currency: z.enum(["USD", "EUR"]).optional().describe("Currency (default USD)"),
      due_date: z.string().optional().describe("Due date YYYY-MM-DD"),
      notes: z.string().optional().describe("Private notes (not visible to client)"),
      message: z.string().optional().describe("Payment terms visible to customer on invoice"),
      mark_as_paid: z.boolean().optional().describe("If true, create as Paid with today's date (invoices are receipts per rule P6)"),
      paid_date: z.string().optional().describe("Override paid date (YYYY-MM-DD) if different from today"),
    },
    async ({ contact_id, account_id, line_items, currency, due_date, notes, message, mark_as_paid, paid_date }) => {
      try {
        if (!contact_id && !account_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of contact_id or account_id is required. Contact = person (pre-account). Account = company." }] }
        }

        const cur = currency || "USD"

        // Resolve customer info for display
        let customerName = ""
        let resolvedContactId = contact_id
        const resolvedAccountId = account_id

        if (contact_id) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("full_name, email")
            .eq("id", contact_id)
            .single()
          if (!contact) return { content: [{ type: "text" as const, text: `Contact ${contact_id} not found` }] }
          customerName = contact.full_name
        }

        if (account_id) {
          const { data: account } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", account_id)
            .single()
          if (!account) return { content: [{ type: "text" as const, text: `Account ${account_id} not found` }] }

          if (!contact_id) {
            const { data: link } = await supabaseAdmin
              .from("account_contacts")
              .select("contact_id, contacts(full_name)")
              .eq("account_id", account_id)
              .limit(1)
              .single()
            if (link) {
              resolvedContactId = link.contact_id
              const c = link.contacts as unknown as { full_name: string }
              if (!customerName) customerName = c.full_name
            }
          }

          customerName = account.company_name
        }

        if (!customerName) {
          return { content: [{ type: "text" as const, text: "Could not resolve customer name from contact or account" }] }
        }

        // Create TD invoice (writes to payments + client_expenses, NOT client_invoices)
        const { createTDInvoice } = await import("@/lib/portal/td-invoice")
        let result: Awaited<ReturnType<typeof createTDInvoice>>
        try {
          result = await createTDInvoice({
            account_id: resolvedAccountId || undefined,
            contact_id: resolvedContactId || undefined,
            line_items,
            currency: cur as 'USD' | 'EUR',
            due_date: due_date || undefined,
            notes: notes || undefined,
            message: message || undefined,
            mark_as_paid: mark_as_paid || false,
            paid_date: paid_date || undefined,
          })
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Failed to create invoice: ${err instanceof Error ? err.message : String(err)}` }] }
        }

        const { paymentId, invoiceNumber, total, status } = result

        // Auto-create Whop checkout plan for card payment (+5%)
        let whopUrl: string | null = null
        try {
          const whopKey = process.env.WHOP_API_KEY
          if (whopKey && !mark_as_paid) {
            const cardAmount = Math.ceil(total * 1.05)
            const firstItem = line_items[0]?.description || "Invoice"
            const planTitle = `${firstItem} - ${customerName}`.substring(0, 80)

            const prodRes = await fetch("https://api.whop.com/api/v1/products?company_id=biz_rssyD9YyMnXd7P&first=50", {
              headers: { Authorization: `Bearer ${whopKey}`, "Content-Type": "application/json" },
            })
            const prodData = await prodRes.json()
            const products = prodData.data || []
            const defaultProduct = products.find((p: { title: string }) => p.title?.includes("Onboarding")) || products[0]

            if (defaultProduct) {
              const planRes = await fetch("https://api.whop.com/api/v1/plans", {
                method: "POST",
                headers: { Authorization: `Bearer ${whopKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  company_id: "biz_rssyD9YyMnXd7P",
                  product_id: defaultProduct.id,
                  title: planTitle,
                  initial_price: cardAmount,
                  currency: cur.toLowerCase(),
                  plan_type: "one_time",
                  release_method: "buy_now",
                  visibility: "visible",
                  unlimited_stock: true,
                }),
              })
              if (planRes.ok) {
                const plan = await planRes.json()
                whopUrl = plan.purchase_url || `https://whop.com/checkout/${plan.id}`

                // Store on payments record (not client_invoices)
                // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
                await supabaseAdmin
                  .from("payments")
                  .update({ whop_payment_id: plan.id })
                  .eq("id", paymentId)
              }
            }
          }
        } catch {
          // Whop plan creation failed — invoice still works, just no card option
        }

        await logAction({
          action_type: "create",
          table_name: "payments",
          record_id: paymentId,
          account_id: resolvedAccountId || undefined,
          summary: `TD invoice ${invoiceNumber} created: ${cur} ${total.toFixed(2)} (${status})${whopUrl ? " + Whop checkout" : ""}`,
        })

        // Notify client about new invoice
        if (!mark_as_paid && (resolvedAccountId || resolvedContactId)) {
          const { createPortalNotification } = await import("@/lib/portal/notifications")
          await createPortalNotification({
            account_id: resolvedAccountId || undefined,
            contact_id: resolvedContactId || undefined,
            type: "invoice",
            title: `New invoice ${invoiceNumber}`,
            body: `${cur === "EUR" ? "EUR" : "$"}${total.toFixed(2)}`,
            link: "/portal/invoices?tab=expenses",
          }).catch(() => {})
        }

        const csym = cur === "EUR" ? "EUR" : "$"
        const cardAmount = Math.ceil(total * 1.05)
        return {
          content: [{
            type: "text" as const,
            text: [
              `Invoice created:`,
              `- Invoice: ${invoiceNumber}`,
              `- Customer: ${customerName}`,
              `- Total: ${csym}${total.toFixed(2)}`,
              `- Status: ${status}`,
              `- Payment ID: ${paymentId}`,
              resolvedContactId ? `- Contact: ${resolvedContactId}` : "",
              resolvedAccountId ? `- Account: ${resolvedAccountId}` : "",
              whopUrl ? `- Card payment: ${whopUrl} (${csym}${cardAmount} with 5% fee)` : "",
              ``,
              mark_as_paid ? "Marked as paid." : "Use portal_invoice_send to email the invoice to the client.",
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_invoice_send ─────────────────────────────────────────────

  server.tool(
    "portal_invoice_send",
    `Send a portal invoice via email with PDF attachment. Marks the invoice as 'Sent'. Email is sent with the client's company name as sender and Reply-To set to the client's email so any replies go directly to them. The email includes invoice details, bank payment instructions, and a Pay Now button if a payment link exists.

Prerequisite: Invoice must exist (created via portal_invoice_create or portal dashboard).`,
    {
      invoice_id: z.string().uuid().describe("Portal invoice UUID (from portal_invoice_create)"),
      email_to: z.string().optional().describe("Override recipient email (default: customer email from invoice)"),
      language: z.enum(["en", "it"]).optional().describe("Email language (default: en)"),
    },
    async ({ invoice_id, email_to, language }) => {
      try {
        const lang = language || "en"

        // Fetch invoice with items
        const { data: invoice } = await supabaseAdmin
          .from("client_invoices")
          .select("*")
          .eq("id", invoice_id)
          .single()

        if (!invoice) return { content: [{ type: "text" as const, text: `Invoice ${invoice_id} not found` }] }

        if (invoice.status === "Sent" || invoice.status === "Paid") {
          return { content: [{ type: "text" as const, text: `Invoice ${invoice.invoice_number} is already ${invoice.status}. Cannot re-send.` }] }
        }

        // Get customer
        const { data: customer } = await supabaseAdmin
          .from("client_customers")
          .select("name, email")
          .eq("id", invoice.customer_id)
          .single()

        const recipientEmail = email_to || customer?.email
        if (!recipientEmail) return { content: [{ type: "text" as const, text: "No recipient email. Provide email_to or ensure customer has email." }] }

        // Get account company name and reply-to email
        const { data: invoiceAccount } = await supabaseAdmin
          .from("accounts")
          .select("company_name")
          .eq("id", invoice.account_id)
          .single()
        const companyName = invoiceAccount?.company_name || "Our Company"

        const { getCompanyEmail } = await import("@/lib/portal/queries")
        const replyTo = invoice.account_id ? await getCompanyEmail(invoice.account_id) : null

        const csym = invoice.currency === "EUR" ? "EUR " : "$"
        const customerName = customer?.name || "Client"
        const greeting = lang === "it" ? `Gentile ${customerName}` : `Dear ${customerName}`
        const subject = `Invoice ${invoice.invoice_number} from ${companyName}`

        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #2563eb; padding: 24px; border-radius: 12px 12px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 20px;">${companyName}</h1>
            </div>
            <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
              <p>${greeting},</p>
              <p>${lang === "it" ? "In allegato la fattura" : "Please find attached invoice"} <strong>${invoice.invoice_number}</strong>.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="background: #f8fafc;"><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Invoice</td><td style="padding: 8px 12px;">${invoice.invoice_number}</td></tr>
                <tr><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Date</td><td style="padding: 8px 12px;">${invoice.issue_date}</td></tr>
                ${invoice.due_date ? `<tr style="background: #f8fafc;"><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Due</td><td style="padding: 8px 12px;">${invoice.due_date}</td></tr>` : ""}
                <tr><td style="padding: 8px 12px; font-weight: bold; color: #6b7280;">Total</td><td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: #2563eb;">${csym}${(invoice.total ?? 0).toFixed(2)}</td></tr>
              </table>
              ${invoice.message ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px;"><p style="margin: 0; font-size: 14px; white-space: pre-wrap;">${invoice.message}</p></div>` : ""}
              <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">${lang === "it" ? "Per domande, rispondi a questa email." : "If you have questions, reply to this email."}</p>
            </div>
          </div>
        `

        // Generate tracking ID and inject pixel
        const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`
        const trackedHtml = html + `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

        // Send via Gmail
        const { gmailPost } = await import("@/lib/gmail")
        const boundary = `boundary_${Date.now()}`
        const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
        const parts = [
          `From: ${companyName} <support@tonydurante.us>`,
          `To: ${recipientEmail}`,
          ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
          `Subject: ${encodedSubject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(trackedHtml).toString("base64"),
          `--${boundary}--`,
        ]
        const raw = Buffer.from(parts.join("\r\n")).toString("base64url")
        const sendResult = await gmailPost("/messages/send", { raw }) as { id?: string; threadId?: string }

        // Store email tracking record
        await supabaseAdmin.from("email_tracking").insert({
          tracking_id: trackingId,
          gmail_message_id: sendResult?.id || null,
          gmail_thread_id: sendResult?.threadId || null,
          recipient: recipientEmail,
          subject,
          from_email: "support@tonydurante.us",
          account_id: invoice.account_id || null,
          contact_id: invoice.contact_id || null,
        })

        // Mark as Sent
        await supabaseAdmin
          .from("client_invoices")
          .update({ status: "Sent", updated_at: new Date().toISOString() })
          .eq("id", invoice_id)

        await logAction({
          action_type: "update",
          table_name: "client_invoices",
          record_id: invoice_id,
          account_id: invoice.account_id || undefined,
          summary: `Portal invoice ${invoice.invoice_number} sent to ${recipientEmail}`,
        })

        return {
          content: [{
            type: "text" as const,
            text: `Invoice ${invoice.invoice_number} sent to ${recipientEmail}. Status updated to Sent.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_inbox ───────────────────────────────────────────────

  server.tool(
    "portal_chat_inbox",
    `PREFERRED tool for checking client messages. Shows all portal chat threads with unread counts, last message preview, and client names.

When Antonio says "read the message", "check messages", "any messages?", "vedi messaggi", or similar → use THIS tool FIRST. Do NOT use msg_inbox (that is legacy WhatsApp/Telegram only).

Returns threads sorted by most recent message. Each thread shows:
- Client name (company or contact)
- Last message preview and timestamp
- Unread count (client messages not yet read by admin)
- account_id and/or contact_id for follow-up with portal_chat_read

Supports filtering:
- No args: all threads with any messages
- unread_only=true: only threads with unread client messages
- account_id: specific company thread
- contact_id: specific person's threads (across all their LLCs + contact-only)`,
    {
      unread_only: z.boolean().optional().default(false).describe("Only show threads with unread client messages"),
      account_id: z.string().uuid().optional().describe("Filter to a specific account/LLC"),
      contact_id: z.string().uuid().optional().describe("Filter to a specific contact/person — shows ALL their threads (account + contact-only)"),
      limit: z.number().optional().default(20).describe("Max threads to return (default 20)"),
    },
    async ({ unread_only, account_id, contact_id, limit }) => {
      try {
        // Same source of truth as the CRM Portal Chats inbox (2026-07-08):
        // get_portal_chat_threads_v2 applies the "one message, one staff
        // thread" rule (multi-member accounts get ONE account-level thread;
        // person threads carry only personal + solo-company messages). The
        // tool previously hand-rolled its own thread list, which double-showed
        // MMLLC messages as both a company and a person thread.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: rows, error } = await (supabaseAdmin as any).rpc("get_portal_chat_threads_v2")
        if (error) {
          return { content: [{ type: "text" as const, text: `Failed to load threads: ${error.message}` }] }
        }

        type ThreadRow = {
          contact_id: string | null
          contact_name: string
          account_id: string | null
          companies: { id: string; name: string }[]
          members: { id: string; name: string }[]
          last_message: string | null
          last_message_at: string | null
          unread_count: number
        }
        let threads = (rows ?? []) as ThreadRow[]

        if (account_id) {
          // Multi-member account → its own account-level thread. Solo account →
          // its messages live in the owner's person thread (companies pill).
          threads = threads.filter(t =>
            t.account_id === account_id || (t.companies ?? []).some(c => c.id === account_id)
          )
        } else if (contact_id) {
          // The person's own thread + every account-level thread they're a member of.
          threads = threads.filter(t =>
            t.contact_id === contact_id || (t.members ?? []).some(m => m.id === contact_id)
          )
        }
        if (unread_only) threads = threads.filter(t => Number(t.unread_count) > 0)
        threads = threads.slice(0, limit)

        if (threads.length === 0) {
          return { content: [{ type: "text" as const, text: unread_only ? "No unread portal messages." : "No portal chat threads found." }] }
        }

        const totalUnread = threads.reduce((sum, t) => sum + Number(t.unread_count), 0)
        const lines = threads.map(t => {
          const unread = Number(t.unread_count)
          const unreadBadge = unread > 0 ? ` [${unread} unread]` : ""
          // Account thread → company (member names); person thread → person (company names)
          const detail = t.account_id
            ? (t.members ?? []).map(m => m.name).join(", ")
            : (t.companies ?? []).map(c => c.name).join(", ")
          const name = detail ? `${t.contact_name} (${detail})` : t.contact_name
          const time = t.last_message_at ? new Date(t.last_message_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""
          const id = t.account_id ? `account_id: ${t.account_id}` : `contact_id: ${t.contact_id}`
          const preview = (t.last_message ?? "").substring(0, 100)
          return `${unread > 0 ? "🔴" : "⚪"} **${name}**${unreadBadge}\n   Last (${time}): "${preview}${(t.last_message ?? "").length > 100 ? "..." : ""}"\n   ${id}`
        })

        return {
          content: [{
            type: "text" as const,
            text: `Portal Chat Inbox — ${totalUnread} unread message${totalUnread !== 1 ? "s" : ""} across ${threads.filter(t => Number(t.unread_count) > 0).length} thread${threads.filter(t => Number(t.unread_count) > 0).length !== 1 ? "s" : ""}\n\n${lines.join("\n\n")}\n\nUse portal_chat_read(account_id or contact_id) to read full conversation.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ portal_chat_inbox error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_read ──────────────────────────────────────────────

  server.tool(
    "portal_chat_read",
    `Read the full message history for a portal chat thread. Returns messages in chronological order with sender info, timestamps, and attachments.

Use after portal_chat_inbox to read a specific conversation. Pass either account_id (for LLC threads) or contact_id (for person threads: the contact's personal messages plus their solo-owned companies' messages; multi-member LLC messages live in their own account thread).

After reading, you should:
1. Summarize what the client said
2. Load their context via crm_get_client_summary if needed
3. Propose a response or action
4. Show the draft to Antonio for approval BEFORE sending via portal_chat_send

Does NOT auto-mark messages as read. Use portal_chat_mark_read explicitly after Antonio has seen the summary.`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID — read LLC thread. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID — read person thread (contact-only, no LLC). At least one of account_id or contact_id required."),
      limit: z.number().optional().default(30).describe("Number of messages to return (default 30, most recent)"),
    },
    async ({ account_id, contact_id, limit: msgLimit }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // Get thread context (client name)
        let clientName = "Unknown"
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          clientName = acct?.company_name ?? account_id
        } else if (contact_id) {
          const { data: ct } = await supabaseAdmin.from("contacts").select("full_name, email").eq("id", contact_id).single()
          clientName = ct?.full_name ?? ct?.email ?? contact_id
        }

        // Fetch messages
        let query = supabaseAdmin
          .from("portal_messages")
          .select("id, sender_type, sender_id, message, attachment_url, attachment_name, attachments, read_at, created_at, contact_id, contacts:contact_id(full_name)")
          .order("created_at", { ascending: false })
          .limit(msgLimit)

        if (account_id) {
          query = query.eq("account_id", account_id)
        } else {
          // Person thread = personal messages + solo-company messages, same
          // scope as the CRM inbox (multi-member accounts' messages live in
          // their own account thread — "one message, one staff thread",
          // 2026-07-08, shared rule in lib/portal/thread-scope.ts).
          const { data: links } = await supabaseAdmin
            .from("account_contacts")
            .select("account_id")
            .eq("contact_id", contact_id!)
          const linked = (links ?? []).map(l => l.account_id as string)
          const excluded = await multiMemberAccountIds(linked)
          query = query.or(contactThreadOrFilter(contact_id!, linked, excluded))
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: messages, error } = await (query as any)
        if (error) return { content: [{ type: "text" as const, text: `Failed to read messages: ${error.message}` }] }
        if (!messages?.length) return { content: [{ type: "text" as const, text: `No messages found for ${clientName}.` }] }

        // Reverse to chronological order
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sorted = (messages as any[]).reverse()

        // Count unread
        const unreadCount = sorted.filter(m => m.sender_type === "client" && !m.read_at).length

        // Format messages
        const formatted = sorted.map(m => {
          const contactData = (m as any).contacts as { full_name: string } | null
          // Staff (admin/system) messages are labelled "TD Team" — never a contact
          // name. The row's contact_id on an admin send is a routing tag (an
          // arbitrary linked member), NOT the author. See staffChatSenderLabel.
          const sender = formatMcpChatSenderLabel(m.sender_type, contactData?.full_name)
          const time = new Date(m.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
          const readStatus = m.sender_type === "client" && !m.read_at ? " 🔴 UNREAD" : ""
          const atts = (m as any).attachments?.length
            ? (m as any).attachments.map((a: { name: string; url: string }) => `\n   📎 ${a.name} — ${a.url}`).join("")
            : m.attachment_url ? `\n   📎 ${m.attachment_name || "file"} — ${m.attachment_url}` : ""
          return `[${time}] ${sender}${readStatus}:\n   ${m.message}${atts}`
        })

        return {
          content: [{
            type: "text" as const,
            text: `Portal Chat — ${clientName} (${unreadCount} unread)\n${"─".repeat(50)}\n\n${formatted.join("\n\n")}\n\n${"─".repeat(50)}\nMessages shown: ${sorted.length}. ${unreadCount > 0 ? "Use portal_chat_mark_read to mark as read after review." : "All messages read."}`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ portal_chat_read error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_mark_read ────────────────────────────────────────────

  server.tool(
    "portal_chat_mark_read",
    `Mark client messages as read in a portal chat thread. Call this AFTER Antonio has reviewed the messages (via portal_chat_read summary), NOT automatically.

This updates read_at on unread client messages, which:
- Clears the unread badge in the CRM dashboard
- Signals to other team members that messages have been handled

Only marks client→admin messages as read (admin messages don't need read tracking).`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID — mark LLC thread as read. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID — mark person thread as read. At least one of account_id or contact_id required."),
    },
    async ({ account_id, contact_id }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // First count unread messages
        let countQuery = supabaseAdmin
          .from("portal_messages")
          .select("id", { count: "exact", head: true })
          .eq("sender_type", "client")
          .is("read_at", null)

        if (account_id) {
          countQuery = countQuery.eq("account_id", account_id)
        } else {
          countQuery = countQuery.eq("contact_id", contact_id!).is("account_id", null)
        }

        const { count } = await countQuery

        // Then update them
        let updateQuery = supabaseAdmin
          .from("portal_messages")
          .update({ read_at: new Date().toISOString() })
          .eq("sender_type", "client")
          .is("read_at", null)

        if (account_id) {
          updateQuery = updateQuery.eq("account_id", account_id)
        } else {
          updateQuery = updateQuery.eq("contact_id", contact_id!).is("account_id", null)
        }

        const { error } = await updateQuery

        if (error) return { content: [{ type: "text" as const, text: `Failed to mark as read: ${error.message}` }] }

        // Get name for confirmation
        let name = ""
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          name = acct?.company_name ?? account_id
        } else if (contact_id) {
          const { data: ct } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contact_id).single()
          name = ct?.full_name ?? contact_id!
        }

        return {
          content: [{
            type: "text" as const,
            text: count && count > 0
              ? `Marked ${count} message${count !== 1 ? "s" : ""} as read for ${name}.`
              : `No unread messages to mark for ${name}.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ portal_chat_mark_read error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_send ────────────────────────────────────────────────

  server.tool(
    "portal_chat_send",
    `Send a message to a client via the portal chat system. The message appears in the client's portal chat immediately. Use for day-to-day communication with portal-enabled clients.

Supports both:
- **Account-level chat** (pass account_id): Messages about a specific LLC
- **Contact-level chat** (pass contact_id): Messages to a person (may not have an LLC yet)

The sender is set to 'admin' (staff). The client sees it in their portal chat.`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID for LLC-related messages. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID for person-level messages. At least one of account_id or contact_id required."),
      message: z.string().describe("Message text to send"),
      attachment_url: z.string().optional().describe("Optional single attachment URL (legacy, for backward compat)"),
      attachment_name: z.string().optional().describe("Optional single attachment filename (legacy, for backward compat)"),
      attachments: z.array(z.object({
        url: z.string(),
        name: z.string(),
        mime_type: z.string().optional(),
        size: z.number().optional(),
      })).optional().describe("Array of file attachments. Preferred over attachment_url for one or more files."),
    },
    async ({ account_id, contact_id, message: msgText, attachment_url, attachment_name, attachments }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // Admin sender ID (Antonio's auth user ID)
        const senderId = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

        // Send-scope invariant (2026-08-07 cross-company leak, dev job 4bad3094):
        // when BOTH ids are passed, the account must actually be one of the
        // contact's companies — a mismatched pair is exactly how private
        // messages ended up readable by another company's member. Fails closed.
        if (account_id && contact_id) {
          const linked = await isContactLinkedToAccount(account_id, contact_id)
          if (!linked) {
            return {
              content: [{
                type: "text" as const,
                text: "Error: the contact is not a member of that account — sending would expose the message to the wrong client's company thread. Pass one of the contact's own accounts, or send with contact_id only (personal thread).",
              }],
            }
          }
        }

        // LANGUAGE GUARD — this tool is a third, independent way a portal message
        // reaches a client (Claude Code / Claude.ai sessions, not the AI worker
        // surfaces), and it had NO language check at all (2026-08-22, dev job
        // 6a927407): the AI-worker paths use shouldRefusePortalDraftLanguage, this
        // tool never called it, sending immediately with zero check. Same guard,
        // same "client language on file is Italian, draft is English" rule.
        const { shouldRefusePortalDraftLanguage } = await import("@/lib/ai-agent/worker-tools")
        const refuseLanguage = await shouldRefusePortalDraftLanguage({
          account_id: account_id ?? null,
          contact_id: contact_id ?? null,
          message: msgText,
        })
        if (refuseLanguage) {
          return {
            content: [{
              type: "text" as const,
              text: "Not sent — this client's language on file is Italian, but the message is in English. Draft the message in Italian and try again. (TD rule: a client-facing send must match the client's language on file — do not translate and resend without showing the new draft first.)",
            }],
          }
        }

        // Resolve contact_id: if only account_id was provided, tag the member
        // actually being answered — deterministically (reply-author → last
        // client sender → primary/first), via the same shared helper the chat
        // route uses. Replaces the old arbitrary `.limit(1)` pick that tagged
        // the wrong MMLLC member.
        let resolvedContactId = contact_id || null
        if (!resolvedContactId && account_id) {
          resolvedContactId = await resolveAdminReplyContact(account_id, null)
        }

        const { data: msg, error } = await supabaseAdmin
          .from("portal_messages")
          .insert({
            account_id: account_id || null,
            contact_id: resolvedContactId,
            sender_type: "admin",
            sender_id: senderId,
            message: msgText,
            attachment_url: attachment_url || null,
            attachment_name: attachment_name || null,
            attachments: attachments ?? [],
          })
          .select("id, created_at")
          .single()

        if (error) return { content: [{ type: "text" as const, text: `Failed to send message: ${error.message}` }] }

        await logAction({
          action_type: "create",
          table_name: "portal_messages",
          record_id: msg.id,
          account_id: account_id || undefined,
          summary: `Portal chat message sent: "${msgText.substring(0, 80)}${msgText.length > 80 ? "..." : ""}"`,
        })

        // Staff reply = read (WhatsApp semantics): clear this conversation's
        // client unread so the staff red dot goes away. Same helper the reply
        // API uses, so every send surface behaves identically.
        const { markClientMessagesReadForStaffReply } = await import("@/lib/portal/mark-thread-read")
        await markClientMessagesReadForStaffReply({
          account_id: account_id || null,
          contact_id: resolvedContactId || null,
        }).catch(() => 0)

        // In-app notification + email to client (fire-and-forget)
        const { createPortalNotification, notifyClientOfAdminMessage } = await import("@/lib/portal/notifications")
        createPortalNotification({
          account_id: account_id || undefined,
          contact_id: contact_id || undefined,
          type: "chat",
          title: "New message from Tony Durante Team",
          body: msgText.slice(0, 100),
          link: "/portal/chat",
        }).catch(() => {})
        notifyClientOfAdminMessage({
          account_id: account_id || null,
          contact_id: contact_id || null,
          messagePreview: msgText,
        }).catch(() => {})

        // Identify recipient for confirmation
        let recipientName = ""
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          recipientName = acct?.company_name || account_id
        } else if (contact_id) {
          const { data: cnt } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contact_id).single()
          recipientName = cnt?.full_name || contact_id
        }

        return {
          content: [{
            type: "text" as const,
            text: `Message sent to ${recipientName} via portal chat.\nMessage ID: ${msg.id}\nTimestamp: ${msg.created_at}`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_chat_attach_file ────────────────────────────────────────────

  server.tool(
    "portal_chat_attach_file",
    `Move a file that already exists in Drive, Gmail, a URL, or Supabase Storage into the SAME public storage the portal chat's own attachments use, and return a link ready to pass into portal_chat_send's "attachments" array. This does NOT send anything — call portal_chat_send afterward with the returned url/name/mime_type/size.

Use this to hand a client a file we generated or already hold (a P&L export, a signed agreement, a document from Drive) directly in a chat message, without depending on that file's Drive sharing permissions — the destination bucket is public by design, exactly like the files clients themselves upload in chat.

Workflow for a Drive file: source='drive' + file_id. Google-native files (Docs/Sheets/Slides) are exported automatically (Sheets→xlsx, Docs/Slides→pdf).
Workflow for a Gmail attachment: source='gmail' + message_id + attachment_id.
Workflow for a URL: source='url' + url.
Workflow for Supabase Storage: source='supabase_storage' + storage_path (+ storage_bucket if not 'assets').

Requires account_id or contact_id — whichever thread the file is headed to — since that determines the storage folder. Max ~4MB (same ceiling as drive_upload_file; the file is held fully in memory for the copy).`,
    {
      source: z.enum(["drive", "gmail", "url", "supabase_storage"]).describe("Where to get the file: 'drive' = Google Drive file, 'gmail' = Gmail attachment, 'url' = download from URL, 'supabase_storage' = Supabase Storage bucket"),
      account_id: z.string().uuid().optional().describe("Account UUID for the LLC thread the file is headed to. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID for the person-level thread the file is headed to. At least one of account_id or contact_id required."),
      filename: z.string().optional().describe("Override filename (auto-detected from source if omitted)"),
      file_id: z.string().optional().describe("Google Drive file ID (required when source='drive')"),
      message_id: z.string().optional().describe("Gmail message ID (required when source='gmail')"),
      attachment_id: z.string().optional().describe("Gmail attachment ID from message parts (required when source='gmail')"),
      url: z.string().optional().describe("Direct download URL (required when source='url')"),
      storage_path: z.string().optional().describe("File path inside the Supabase Storage bucket (required when source='supabase_storage')"),
      storage_bucket: z.string().optional().describe("Supabase Storage bucket name (default: 'assets' — only needed if the file lives in a different bucket)"),
    },
    async ({ source, account_id, contact_id, filename, file_id, message_id, attachment_id, url, storage_path, storage_bucket }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: account_id or contact_id is required — it determines which client's chat storage folder the file lands in." }] }
        }

        let buffer: Buffer
        let finalFilename: string
        let mimeType: string

        if (source === "drive") {
          if (!file_id) {
            return { content: [{ type: "text" as const, text: "Error: file_id is required when source='drive'." }] }
          }
          const result = await downloadFileBinaryForSend(file_id)
          buffer = result.buffer
          mimeType = result.mimeType
          finalFilename = filename || result.fileName
        } else if (source === "gmail") {
          if (!message_id || !attachment_id) {
            return { content: [{ type: "text" as const, text: "Error: message_id and attachment_id are required when source='gmail'. Use gmail_read first to get these values." }] }
          }
          const { data } = await getGmailAttachment(message_id, attachment_id)
          buffer = data
          if (filename) {
            finalFilename = filename
            mimeType = guessMimeType(filename)
          } else {
            const { gmailGet } = await import("@/lib/gmail")
            const msg = (await gmailGet(`/messages/${message_id}`, { format: "full" })) as {
              payload: { parts?: Array<{ filename?: string; mimeType: string; body?: { attachmentId?: string } }> }
            }
            const part = msg.payload.parts?.find((p) => p.body?.attachmentId === attachment_id)
            finalFilename = part?.filename || `attachment-${Date.now()}`
            mimeType = part?.mimeType || "application/octet-stream"
          }
        } else if (source === "url") {
          if (!url) {
            return { content: [{ type: "text" as const, text: "Error: url is required when source='url'." }] }
          }
          const res = await fetch(url)
          if (!res.ok) {
            return { content: [{ type: "text" as const, text: `Error: failed to download from URL: ${res.status} ${res.statusText}` }] }
          }
          buffer = Buffer.from(await res.arrayBuffer())
          const disposition = res.headers.get("content-disposition")
          if (filename) {
            finalFilename = filename
          } else if (disposition) {
            const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i)
            finalFilename = match ? decodeURIComponent(match[1]) : `download-${Date.now()}`
          } else {
            finalFilename = new URL(url).pathname.split("/").pop() || `download-${Date.now()}`
          }
          mimeType = res.headers.get("content-type") || "application/octet-stream"
        } else {
          if (!storage_path) {
            return { content: [{ type: "text" as const, text: "Error: storage_path is required when source='supabase_storage'." }] }
          }
          const bucket = storage_bucket || "assets"
          const cleanPath = storage_path.replace(/^\/+/, "")
          const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(bucket).download(cleanPath)
          if (dlErr || !blob) {
            return { content: [{ type: "text" as const, text: `Error: failed to download from Supabase Storage (${bucket}/${cleanPath}): ${dlErr?.message || "no data returned"}` }] }
          }
          buffer = Buffer.from(await blob.arrayBuffer())
          finalFilename = filename || cleanPath.split("/").pop() || `storage-file-${Date.now()}`
          mimeType = blob.type || "application/octet-stream"
        }

        const MAX_SIZE = 4 * 1024 * 1024
        if (buffer.length > MAX_SIZE) {
          return { content: [{ type: "text" as const, text: `Error: file too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max supported: ~4MB.` }] }
        }

        const destPath = buildChatAttachmentPath(finalFilename, account_id ?? null, contact_id ?? null)
        const { error: uploadError } = await supabaseAdmin.storage
          .from("assets")
          .upload(destPath, buffer, { contentType: mimeType, upsert: false })
        if (uploadError) {
          return { content: [{ type: "text" as const, text: `Error: upload failed: ${uploadError.message}` }] }
        }

        const { data: urlData } = supabaseAdmin.storage.from("assets").getPublicUrl(destPath)

        await logAction({
          action_type: "create",
          table_name: "portal_chat_attachment",
          record_id: destPath,
          account_id: account_id || undefined,
          contact_id: contact_id || undefined,
          summary: `Staged chat attachment from ${source}: ${finalFilename} (${(buffer.length / 1024).toFixed(1)}KB)`,
        })

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Ready to attach`,
              ``,
              `Name: ${finalFilename}`,
              `Type: ${mimeType}`,
              `Size: ${(buffer.length / 1024).toFixed(1)}KB`,
              `URL: ${urlData.publicUrl}`,
              ``,
              `Pass this to portal_chat_send as one entry in "attachments":`,
              `{ "url": "${urlData.publicUrl}", "name": "${finalFilename}", "mime_type": "${mimeType}", "size": ${buffer.length} }`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ─── portal_team_send ─────────────────────────────────────────────────

  server.tool(
    "portal_team_send",
    `Send an internal team message visible ONLY to staff (Antonio, Luca, Claude). NOT visible to clients.

Creates or reuses an internal discussion thread linked to a client account or contact. The message appears in the CRM dashboard under Portal Chats > Team tab. Staff receive real-time toast notifications + push notifications.

Use this for:
- Flagging something for Luca to check (e.g., "Check Delaware SOS for this company")
- Internal notes about a client situation
- Team coordination on a client case

NEVER use portal_chat_send for team-only messages — clients can see those.

Supports both:
- **Account-level** (pass account_id): Discussion about a specific LLC
- **Contact-level** (pass contact_id): Discussion about a person (may not have an LLC yet)`,
    {
      account_id: z.string().uuid().optional().describe("Account UUID for LLC-related discussions. At least one of account_id or contact_id required."),
      contact_id: z.string().uuid().optional().describe("Contact UUID for person-level discussions. At least one of account_id or contact_id required."),
      message: z.string().describe("Team message text"),
      source_message_id: z.string().uuid().optional().describe("Portal message ID that triggered this discussion (optional, for context)"),
    },
    async ({ account_id, contact_id, message: msgText, source_message_id }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "Error: At least one of account_id or contact_id is required." }] }
        }

        // Resolve context name for thread title
        let contextName = "Client"
        if (account_id) {
          const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
          contextName = acct?.company_name || account_id
        } else if (contact_id) {
          const { data: cnt } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contact_id).single()
          contextName = cnt?.full_name || contact_id
        }

        // Check for existing unresolved thread — reuse it
        let query = supabaseAdmin
          .from("internal_threads")
          .select("*")
          .is("resolved_at", null)
          .order("created_at", { ascending: false })
          .limit(1)

        if (account_id) {
          query = query.eq("account_id", account_id)
        } else {
          query = query.eq("contact_id", contact_id!)
        }

        const { data: existingThread } = await query.single()

        // Admin sender ID (Claude uses Antonio's admin ID as sender context)
        const senderId = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"
        const senderName = "Claude"

        let threadId: string
        let reused = false

        if (existingThread) {
          threadId = existingThread.id
          reused = true
        } else {
          // Create new thread
          const { data: newThread, error: threadErr } = await supabaseAdmin
            .from("internal_threads")
            .insert({
              account_id: account_id || null,
              contact_id: contact_id || null,
              source_message_id: source_message_id || null,
              created_by: senderId,
              title: contextName,
            })
            .select("id")
            .single()

          if (threadErr) return { content: [{ type: "text" as const, text: `Failed to create thread: ${threadErr.message}` }] }
          threadId = newThread.id
        }

        // Insert the message
        const { data: msg, error: msgErr } = await supabaseAdmin
          .from("internal_messages")
          .insert({
            thread_id: threadId,
            sender_id: senderId,
            sender_name: senderName,
            message: msgText,
          })
          .select("id, created_at")
          .single()

        if (msgErr) return { content: [{ type: "text" as const, text: `Failed to send message: ${msgErr.message}` }] }

        // Send push notification to all admins
        try {
          // No pre-check on the subscription table: who receives is decided by
          // the staff directory inside sendPushToStaffExcept, and a failed probe
          // here used to swallow the notification with no log.
          const { sendPushToStaffExcept } = await import("@/lib/team/notify")
          await sendPushToStaffExcept(senderId, {
            title: `Team: ${contextName}`,
            body: msgText.slice(0, 100),
            url: "/portal-chats?view=internal",
            tag: `internal-thread-${threadId}`,
          })
        } catch {
          // Push notification failure is non-critical
        }

        await logAction({
          action_type: "create",
          table_name: "internal_messages",
          record_id: msg.id,
          account_id: account_id || undefined,
          summary: `Team message sent re: ${contextName}: "${msgText.substring(0, 80)}${msgText.length > 80 ? "..." : ""}"`,
        })

        return {
          content: [{
            type: "text" as const,
            text: `Team message sent re: ${contextName}${reused ? " (added to existing thread)" : " (new thread created)"}.\nThread ID: ${threadId}\nMessage ID: ${msg.id}\nTimestamp: ${msg.created_at}\n\nVisible in CRM > Portal Chats > Team tab.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}
