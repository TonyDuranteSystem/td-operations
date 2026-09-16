/**
 * DEPRECATED — Legacy Portal Transition MCP Tools
 * Retired 2026-09-15. Dormant since 2026-04-09 (confirmed unused for 5 months).
 *
 * portal_transition_setup and portal_transition_batch decided which client
 * documents to expose in the client portal using only a document-type-name
 * allowlist (PORTAL_VISIBLE_DOC_TYPES) and a category allowlist
 * (PORTAL_VISIBLE_CATEGORIES) — with NO check for whether a "personal"
 * document (category 2 — passport/ID/ITIN letter, etc.) had a confirmed
 * single owner (contact_id) before making it visible client-side. That gap
 * already caused one real, since-corrected client-document privacy exposure
 * (same class of bug fixed elsewhere this session in
 * lib/documents/visibility-guard.ts). The business decided to retire this
 * tool rather than fix it — the 2026 legacy portal transition is complete
 * and this bulk cascade is not needed anymore.
 *
 * Kept here for reference only. This file is never registered on the MCP
 * server (see app/api/[transport]/route.ts) — same treatment as
 * lib/mcp/tools/deprecated/qb.ts.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { PORTAL_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"
import { updateAccount } from "@/lib/operations/account"
import { createSD } from "@/lib/operations/service-delivery"
import { syncTier } from "@/lib/operations/sync-tier"
import { collectFilesRecursive, processFile } from "@/lib/mcp/tools/doc"
import { buildTransitionWelcomeEmail } from "@/lib/mcp/tools/offers"
import { gmailPost } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import type { MailingAddressRow } from "@/lib/addresses"
import { LLC_MANAGEMENT_BUNDLE_TYPES } from "@/lib/services"

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

export function registerDeprecatedPortalTransitionTools(server: McpServer) {
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
}
