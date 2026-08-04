/**
 * Job Handler: tax_form_setup
 *
 * Two modes depending on payload.source:
 *
 * 1. "portal_wizard" — Full post-submission workflow triggered by the portal tax wizard:
 *    - Contact update from submitted_data
 *    - Passport check for one-time customers
 *    - Create review task for team
 *    - Update tax_returns → Data Received
 *    - Advance service_delivery → Data Received
 *    - Save Tax Organizer PDF + uploaded files to Drive (3. Tax/{year}/)
 *    - Parse bank statements + generate P&L Excel for MMLLC/Corp
 *    - Detailed email notification to team
 *    - Mark submission as reviewed
 *
 * 2. MCP apply_changes (default) — Executes the apply_changes phase of tax_form_review:
 *    - Contact update from changed_fields diff
 *    - Account update from changed_fields diff
 *    - Tax return → Data Received
 *    - Advance service_delivery → Data Received
 *    - Email notification
 *    - Form → reviewed
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { updateJobProgress, type Job, type JobResult } from "../queue"
import { emitActionNeeded } from "@/lib/notifications/act-event"
import { emitClientChatEvent } from "@/lib/portal/chat-events"
import { buildReviewHistoryEntry, type ReviewStatus } from "@/lib/tax/review-status"

interface TaxFormPayload {
  token: string
  submission_id: string | null
  contact_id: string | null
  account_id: string | null
  tax_return_id: string | null
  /** Pinned by the submit route's eligibility resolver (PTBT fix) — used verbatim when present. */
  tax_year?: number | null
  changed_fields: Record<string, { old: unknown; new: unknown }> | null
  submitted_data?: Record<string, unknown>
  upload_paths?: string[]
  entity_type?: string
  company_name?: string
  source?: "portal_wizard" | string
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

/**
 * Race a promise against a timeout so a slow/hung dependency can't stall the
 * whole job. On timeout it REJECTS — the caller's try/catch records the step
 * and continues. Used for the best-effort Drive archival (copying many uploaded
 * files to Drive can be slow; the client's P&L is built from bank_transactions,
 * NOT from Drive, so a Drive stall must never block the job from completing).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ])
}

// ─── Portal Wizard: Full Post-Submission Workflow ───

async function handlePortalWizardTaxSetup(job: Job, p: TaxFormPayload): Promise<JobResult> {
  const result: JobResult = { steps: [] }
  const now = new Date().toISOString()
  const sd = (p.submitted_data || {}) as Record<string, unknown>
  const entityType = p.entity_type || (sd.entity_type as string) || "SMLLC"
  const uploadPaths = p.upload_paths || []

  // ─── 0. RESOLVE TAX RETURN (tax_year + id) ───
  // The submit route PINS the year + tax_returns row via the eligibility
  // resolver and passes them in the payload — use them verbatim. The old
  // "any active tax return" fallback attributed a resubmission to an
  // already-FILED year, and a missing row used to fall through to the DB
  // default / calendar guesses (the PTBT silent-2025 incident). For legacy
  // payloads without a pinned year, only an OPEN row counts; no row = the
  // steps that need a year are skipped loudly, never guessed.
  let taxReturnId: string | null = p.tax_return_id
  let taxYear: number | null = typeof p.tax_year === "number" ? p.tax_year : null
  let companyName = p.company_name || p.token

  if (p.account_id) {
    try {
      // Get company name if not in payload
      if (!p.company_name) {
        const { data: acc } = await supabaseAdmin
          .from("accounts")
          .select("company_name")
          .eq("id", p.account_id)
          .single()
        if (acc) companyName = acc.company_name
      }

      if (taxYear !== null) {
        result.steps.push(step("tax_return_lookup", "ok", `Pinned by submit route: tax_year ${taxYear}${taxReturnId ? `, tax_returns ${taxReturnId}` : ""}`))
      } else {
        const { data: tr } = await supabaseAdmin
          .from("tax_returns")
          .select("id, tax_year, status")
          .eq("account_id", p.account_id)
          .eq("data_received", false)
          .order("tax_year", { ascending: true })
          .limit(1)
          .maybeSingle()

        if (tr) {
          taxReturnId = tr.id
          taxYear = tr.tax_year
          result.steps.push(step("tax_return_lookup", "ok", `Found open tax_returns ${tr.id} (${tr.tax_year})`))
        } else {
          result.steps.push(step("tax_return_lookup", "skipped", "No OPEN tax_returns record — year-dependent steps will skip (never guessed)"))
        }
      }
    } catch (e) {
      result.steps.push(step("tax_return_lookup", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 1. CONTACT UPDATE FROM submitted_data ───
  if (p.contact_id) {
    try {
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("phone, residency, citizenship")
        .eq("id", p.contact_id)
        .single()

      if (contact) {
        const updates: Record<string, unknown> = {}
        if (sd.owner_phone && sd.owner_phone !== contact.phone) updates.phone = sd.owner_phone
        if (sd.owner_tax_residency && sd.owner_tax_residency !== contact.citizenship) updates.citizenship = sd.owner_tax_residency

        const newAddr = [sd.owner_street, sd.owner_city, sd.owner_state_province, sd.owner_zip, sd.owner_country]
          .filter(Boolean).join(", ")
        if (newAddr && newAddr !== contact.residency) updates.residency = newAddr

        if (Object.keys(updates).length > 0) {
          updates.updated_at = now
          // eslint-disable-next-line no-restricted-syntax
          await supabaseAdmin.from("contacts").update(updates).eq("id", p.contact_id)
          result.steps.push(step("contact_update", "ok", `Updated: ${Object.keys(updates).filter(k => k !== "updated_at").join(", ")}`))
        } else {
          result.steps.push(step("contact_update", "skipped", "No changes detected"))
        }
      } else {
        result.steps.push(step("contact_update", "skipped", "Contact not found"))
      }
    } catch (e) {
      result.steps.push(step("contact_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("contact_update", "skipped", "No contact_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 2. PASSPORT CHECK FOR ONE-TIME CUSTOMERS ───
  if (p.account_id && p.contact_id) {
    try {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("account_type")
        .eq("id", p.account_id)
        .single()

      if (acc?.account_type === "One-Time") {
        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("passport_on_file, full_name, email")
          .eq("id", p.contact_id)
          .single()

        if (contact && !contact.passport_on_file) {
          // eslint-disable-next-line no-restricted-syntax
          await supabaseAdmin.from("tasks").insert({
            task_title: `[MISSING] Request passport from ${contact.full_name || "client"} (${companyName})`,
            description: [
              `One-time client ${companyName} submitted tax form but has NO passport on file.`,
              `Email ${contact.email || "client"} to request a clear passport scan.`,
              `Passport is required for tax return filing.`,
            ].join("\n"),
            assigned_to: "Luca",
            priority: "Urgent",
            category: "Document",
            status: "To Do",
            due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
            account_id: p.account_id,
            contact_id: p.contact_id,
            created_by: "System",
          })
          result.steps.push(step("passport_check", "ok", "One-time client, no passport — urgent task created"))
        } else {
          result.steps.push(step("passport_check", "skipped", contact?.passport_on_file ? "Passport on file" : "Contact not found"))
        }
      } else {
        result.steps.push(step("passport_check", "skipped", "Annual client"))
      }
    } catch (e) {
      result.steps.push(step("passport_check", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 3. CREATE REVIEW TASK ───
  if (p.account_id) {
    try {
      const taskTitle = `Review tax form data -- ${companyName}${taxYear ? ` (${taxYear})` : ""}`
      const { data: existing } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("task_title", taskTitle)
        .eq("account_id", p.account_id)
        .maybeSingle()

      if (!existing) {
        // eslint-disable-next-line no-restricted-syntax
        await supabaseAdmin.from("tasks").insert({
          task_title: taskTitle,
          description: [
            `Client ${companyName} has submitted tax data${taxYear ? ` for ${taxYear}` : ""}.`,
            ``,
            `Entity type: ${entityType}`,
            `Token: ${p.token}`,
            `Review: tax_form_review(token="${p.token}")`,
            `Action: Review data completeness, then apply_changes=true to update CRM.`,
          ].join("\n"),
          assigned_to: "Luca",
          priority: "High",
          category: "Tax" as never,
          status: "To Do",
          account_id: p.account_id,
          created_by: "System",
        })
        result.steps.push(step("review_task", "ok", taskTitle))
      } else {
        result.steps.push(step("review_task", "skipped", "Already exists"))
      }
    } catch (e) {
      result.steps.push(step("review_task", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  // ─── 4. (DEFERRED) tax_returns advance moved to client Confirm ───
  // Slice 2 (review workflow): on submit we do NOT flip tax_returns to
  // "Data Received"/data_received=true. That happens only when the client
  // confirms after staff review (review_status → confirmed) — see the confirm
  // route + lib/tax/review-status.ts. Leaving tax_returns untouched keeps the
  // submission inside the review loop and editable.
  void taxReturnId
  result.steps.push(step("tax_return_update", "skipped", "Deferred to client confirm (review workflow)"))

  await updateJobProgress(job.id, result)

  // ─── 5. MOVE SERVICE DELIVERY → DATA SUBMITTED (review block) ───
  // Not "Data Received": the SD parks at the single "Data Submitted" macro
  // stage for the whole review; review_status tracks the sub-state; only the
  // client's Confirm releases it forward (Slice 2 design decision 2026-06-09).
  if (p.account_id) {
    try {
      const { data: sdRecord } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, stage, stage_order, stage_history")
        .eq("account_id", p.account_id)
        .or("service_type.eq.Tax Return,service_type.eq.Tax Return Filing")
        .eq("status", "active")
        .limit(1)
        .maybeSingle()

      if (sdRecord) {
        // PRECONDITION (PTBT fix): only a wizard-open stage may advance to
        // "Data Submitted". The old unconditional UPDATE dragged an SD there
        // from ANY stage — 1st Installment Paid (premature submission, the
        // 2nd-installment billing gate skipped) or even BACKWARD from
        // Preparation on a stale-tab resubmit. A resubmit already at
        // "Data Submitted" is a clean no-op (no history churn).
        // "Revision Requested" is included (Carasso edit-button fix, 2026-07-23):
        // when staff requested changes the SD sits at that stage showing a
        // "waiting for the client" notice; the client's resubmit must move it
        // BACK to "Data Submitted" so staff see the response and can re-review —
        // otherwise the flow board and client tracker stay stuck on "Revision
        // Requested" for the rest of the loop.
        const SD_ADVANCE_FROM_STAGES = new Set(["Wizard Available", "Payment Received", "Revision Requested"])
        if (sdRecord.stage === "Data Submitted") {
          result.steps.push(step("sd_advance", "skipped", `SD ${sdRecord.id} already at Data Submitted (resubmit)`))
        } else if (!sdRecord.stage || !SD_ADVANCE_FROM_STAGES.has(sdRecord.stage)) {
          result.steps.push(step("sd_advance", "skipped",
            `SD ${sdRecord.id} at "${sdRecord.stage ?? "NULL"}" — not a wizard-open stage, refusing to advance (eligibility gate should have blocked this submit)`))
        } else {
        const history = Array.isArray(sdRecord.stage_history) ? sdRecord.stage_history : []
        history.push({
          event: "tax_form_submitted",
          from_stage: sdRecord.stage,
          to_stage: "Data Submitted",
          advanced_at: now,
          notes: sdRecord.stage === "Revision Requested"
            ? "Client resubmitted after a revision request — back into review (review_status=resubmitted)"
            : "Client submitted tax form via portal — entering review (review_status=submitted)",
        })

        // eslint-disable-next-line no-restricted-syntax
        const { error: sdErr } = await supabaseAdmin
          .from("service_deliveries")
          .update({
            stage: "Data Submitted",
            stage_order: 45,
            stage_entered_at: now,
            stage_history: history,
          })
          .eq("id", sdRecord.id)
          .eq("stage", sdRecord.stage)

        if (sdErr) {
          result.steps.push(step("sd_advance", "error", sdErr.message))
        } else {
          result.steps.push(step("sd_advance", "ok", `SD ${sdRecord.id} → Data Submitted`))
        }
        }
      } else {
        result.steps.push(step("sd_advance", "skipped", "No active Tax Return SD found"))
      }
    } catch (e) {
      result.steps.push(step("sd_advance", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 6. BANK STATEMENTS → per-file background ingest jobs (MMLLC/Corp) ───
  // ENQUEUED EARLY — BEFORE the Drive copy below — because that copy can be
  // slow / hang / get killed with many files, and the client's P&L must not
  // depend on it. One small `ingest_bank_statement` job per file (CSV or PDF);
  // the worker drains them and the financials view builds on demand.
  if ((entityType === "MMLLC" || entityType === "Corp") && p.account_id && taxYear) {
    const acctId = p.account_id
    const ty = taxYear
    try {
      // Idempotent backstop. The portal wizard-submit route already enqueues
      // these synchronously at submit time (reliable even if THIS handler is
      // killed mid-run); the staff review path relies on this call. The helper
      // skips any file already queued, so a PDF is never AI-extracted twice.
      const { enqueueStatementIngestJobs } = await import("@/lib/tax/statement-ingest-enqueue")
      const { enqueued, skipped } = await enqueueStatementIngestJobs({
        accountId: acctId,
        taxYear: ty,
        uploadPaths,
        submittedData: sd as Record<string, unknown>,
        createdBy: "portal_wizard",
      })
      if (enqueued === 0 && skipped === 0) {
        result.steps.push(step("portal_csv_ingest", "skipped", "No bank statement uploads on the submission"))
      } else {
        result.steps.push(step("portal_csv_ingest", "ok",
          `Queued ${enqueued} statement ingest job(s)${skipped > 0 ? ` (${skipped} already queued)` : ""} — transactions land as each completes`))
      }
    } catch (e) {
      result.steps.push(step("portal_csv_ingest", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 6b. DRIVE SAVE (Tax Organizer PDF + uploaded files) ───
  if (p.account_id) {
    try {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("drive_folder_id")
        .eq("id", p.account_id)
        .single()

      if (acc?.drive_folder_id) {
        const { saveFormToDrive } = await import("@/lib/form-to-drive")
        // Best-effort archival, time-boxed: copying many files to Drive can be
        // slow (or hang in sandbox where Drive is mocked). If it overruns, the
        // catch below records it and the job completes anyway — ingestion was
        // already enqueued above, so the P&L is unaffected.
        const driveResult = await withTimeout(saveFormToDrive(
          "tax_return",
          sd,
          uploadPaths,
          acc.drive_folder_id,
          {
            token: p.token,
            submittedAt: now,
            companyName,
            // No calendar guess: an unpinned year files the package under a
            // fabricated Drive year folder (silent-2025 class). Undated root
            // beats wrongly-dated folder.
            year: taxYear ?? undefined,
          },
          // Portal wizard uploads ALL files to the shared "onboarding-uploads"
          // bucket (app/api/portal/wizard-upload[-url]/route.ts), NOT the tax
          // form's "tax-form-uploads" default. Without this the copy read the
          // wrong bucket and every statement failed (0 files copied → no P&L).
          { bucket: "onboarding-uploads" },
        ), 120_000, "drive_save")

        if (driveResult.summaryFileId) {
          result.steps.push(step("drive_save", "ok",
            `Tax Organizer PDF saved (${driveResult.summaryFileId}), ${driveResult.copied.length} files copied${driveResult.skipped.length > 0 ? `, ${driveResult.skipped.length} already on Drive (skipped)` : ""}`))
        }
        if (driveResult.errors.length > 0) {
          result.steps.push(step("drive_save", "error", driveResult.errors.join(", ")))
        }
        if (driveResult.failed.length > 0) {
          result.steps.push(step("drive_uploads", "error", `Failed: ${driveResult.failed.join(", ")}`))
        }
      } else {
        result.steps.push(step("drive_save", "skipped", "No drive_folder_id for account"))
      }
    } catch (e) {
      result.steps.push(step("drive_save", "error", e instanceof Error ? e.message : String(e)))
    }

    // Backstop: enqueue the DURABLE archive job (Carasso Drive-reliability,
    // 2026-07-24). The inline drive_save above is best-effort with no retry and
    // no marker — this durable job self-heals, sets drive_archived_at on full
    // success, and is idempotent (skips if one is already queued or archived).
    // Kept ALONGSIDE the inline copy on purpose: the MMLLC statement-scrape
    // block below still reads statements from Drive synchronously.
    if (p.submission_id) {
      try {
        const { enqueueTaxArchiveJob } = await import("@/lib/tax/archive-enqueue")
        const r = await enqueueTaxArchiveJob({ submissionId: p.submission_id, accountId: p.account_id, createdBy: "tax_form_setup" })
        result.steps.push(step("archive_enqueue", "ok", `durable archive job: ${r.status}`))
      } catch (e) {
        result.steps.push(step("archive_enqueue", "error", e instanceof Error ? e.message : String(e)))
      }
    }
  }

  await updateJobProgress(job.id, result)

  if ((entityType === "MMLLC" || entityType === "Corp") && p.account_id && taxYear) {
    try {
      const { listFolder, uploadBinaryToDriveUpsert, downloadFileBinary } = await import("@/lib/google-drive")
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("drive_folder_id")
        .eq("id", p.account_id)
        .single()

      if (acc?.drive_folder_id) {
        // Find 3. Tax folder
        const listing = await listFolder(acc.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
        const taxFolder = listing.files?.find(f =>
          f.mimeType === "application/vnd.google-apps.folder" && /^3\.\s*Tax/i.test(f.name)
        )

        if (taxFolder) {
          // Look in the year subfolder first, then fall back to Tax folder
          let statementFolderId = taxFolder.id
          const taxFiles = await listFolder(taxFolder.id, 100) as { files?: { id: string; name: string; mimeType: string }[] }
          const yearFolder = taxFiles.files?.find(f =>
            f.mimeType === "application/vnd.google-apps.folder" && f.name === String(taxYear)
          )
          if (yearFolder) statementFolderId = yearFolder.id

          const statementFiles = await listFolder(statementFolderId, 100) as { files?: { id: string; name: string; mimeType: string }[] }
          const statementPattern = /wise|mercury|relay|chase|statement|bank|estratto/i
          const statements = (statementFiles.files || []).filter(f => {
            const lower = f.name.toLowerCase()
            const isStatement = statementPattern.test(f.name)
            const isSupported = f.mimeType === "application/pdf" || f.mimeType === "text/csv"
              || lower.endsWith(".csv") || lower.endsWith(".pdf") || lower.endsWith(".zip")
            return isStatement && isSupported
          })

          if (statements.length > 0) {
            const { parseBankStatement, categorizeTransaction } = await import("@/lib/bank-statement-parser")

            // Shared roster — curated members ∪ linked contacts, one usable-name
            // rule. Building this list here by hand made this path disagree with
            // the portal ingest and the re-sort. See lib/tax/member-roster.ts.
            const { fetchMemberRoster } = await import("@/lib/tax/member-roster")
            const memberNames = (await fetchMemberRoster(supabaseAdmin, p.account_id)).names

            let totalParsed = 0
            for (const file of statements) {
              try {
                const { data: existing } = await supabaseAdmin
                  .from("bank_transactions")
                  .select("id")
                  .eq("source_file_id", file.id)
                  .limit(1)
                if (existing && existing.length > 0) continue

                const { buffer, mimeType } = await downloadFileBinary(file.id)
                const parseResult = await parseBankStatement(buffer, file.name, mimeType)

                for (const tx of parseResult.transactions) {
                  const txYear = parseInt(tx.transaction_date.substring(0, 4))
                  if (txYear !== taxYear) continue

                  const cat = categorizeTransaction(tx, memberNames, [])
                  await supabaseAdmin.from("bank_transactions").upsert({
                    account_id: p.account_id,
                    tax_year: taxYear,
                    transaction_date: cat.transaction_date,
                    description: cat.description,
                    category: cat.category,
                    subcategory: cat.subcategory,
                    counterparty: cat.counterparty,
                    amount: cat.amount,
                    currency: cat.currency,
                    balance_after: cat.balance_after,
                    bank_name: cat.bank_name,
                    account_type: cat.account_type,
                    transaction_ref: cat.transaction_ref,
                    source_file_id: file.id,
                    is_related_party: cat.is_related_party,
                    notes: cat.notes,
                  }, {
                    onConflict: "account_id,transaction_ref,transaction_date,amount",
                    ignoreDuplicates: true,
                  })
                  totalParsed++
                }
              } catch {
                // Skip individual file errors
              }
            }

            result.steps.push(step("bank_statement_parse", totalParsed > 0 ? "ok" : "skipped",
              `Parsed ${totalParsed} transactions from ${statements.length} statements`))

            // Generate P&L if we have transactions
            if (totalParsed > 0) {
              try {
                const { generatePnlExcel } = await import("@/lib/pnl-generator")
                const pnl = await generatePnlExcel(p.account_id!, taxYear)

                // Upload P&L to Drive. Stable file name → UPSERT: a re-run
                // refreshes the one existing workbook instead of adding a copy.
                await uploadBinaryToDriveUpsert(
                  pnl.fileName,
                  pnl.buffer,
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  yearFolder?.id || taxFolder.id
                )
                result.steps.push(step("pnl_generated", "ok", `P&L Excel uploaded. ${pnl.summary}`))
              } catch (e) {
                result.steps.push(step("pnl_generated", "error", e instanceof Error ? e.message : String(e)))
              }
            }
          } else {
            result.steps.push(step("bank_statement_parse", "skipped", "No bank statement files found"))
          }
        } else {
          result.steps.push(step("bank_statement_parse", "skipped", "No 3. Tax folder found in Drive"))
        }
      }
    } catch (e) {
      result.steps.push(step("bank_statement_parse", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 8. DETAILED EMAIL TO TEAM ───
  try {
    const { gmailPost } = await import("@/lib/gmail")

    const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[TASK] Tax Form Completed (Portal) - ${companyName}${taxYear ? ` (${taxYear})` : ""}</h2>
<p>Client <strong>${companyName}</strong> submitted the tax data collection form via the client portal.</p>

<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Entity type:</td><td style="padding:4px 8px">${entityType}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Tax year:</td><td style="padding:4px 8px">${taxYear || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Revenue reported:</td><td style="padding:4px 8px">${sd.total_revenue || sd.gross_revenue || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Expenses reported:</td><td style="padding:4px 8px">${sd.total_expenses || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Documents uploaded:</td><td style="padding:4px 8px">${uploadPaths.length} files</td></tr>
</table>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Next Steps (per Tax Return SOP)</h3>
<ol>
<li>Review data: <code>tax_form_review(token="${p.token}")</code></li>
<li>If complete, apply changes: <code>tax_form_review(token="${p.token}", apply_changes=true)</code></li>
${(entityType === "MMLLC" || entityType === "Corp") ? `<li>Bank statements auto-parsed. Review: <code>bank_statement_review(account_id="${p.account_id}")</code></li>
<li>Generate P&L: <code>bank_statement_pnl(account_id="${p.account_id}", tax_year=${taxYear})</code></li>` : ""}
<li>Check if 2nd installment is paid (Stage 6 gate)</li>
<li>When ready: <code>tax_send_to_accountant(account_id="${p.account_id}", tax_year=${taxYear})</code></li>
</ol>

<p style="font-size:12px;color:#6b7280">Token: ${p.token} | Admin: ${APP_BASE_URL}/tax-form/${p.token}?preview=td</p>
</div>`

    const raw = Buffer.from(
      `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
      `To: support@tonydurante.us\r\n` +
      // R041: RFC 2047 base64 encoding — companyName can carry non-ASCII.
      `Subject: =?utf-8?B?${Buffer.from(`[TASK] Tax Form Completed (Portal) - ${companyName}${taxYear ? ` (${taxYear})` : ""}`).toString("base64")}?=\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n` +
      emailBody
    ).toString("base64url")

    await gmailPost("/messages/send", { raw })
    result.steps.push(step("email_notification", "ok", `Detailed email sent to support@`))
  } catch (e) {
    result.steps.push(step("email_notification", "error", e instanceof Error ? e.message : String(e)))
  }

  await updateJobProgress(job.id, result)

  // ─── 9. SET review_status (Slice 2 — replaces the old auto "reviewed") ───
  // First submit → 'submitted'; a re-submit after a revision request →
  // 'resubmitted'. We no longer set submission.status='reviewed' on submit —
  // the review state now lives in review_status, and "reviewed" was the old
  // model's auto-approve. review_history records each round.
  if (p.submission_id) {
    try {
      const { data: curSub } = await supabaseAdmin
        .from("tax_return_submissions")
        .select("review_status, review_history")
        .eq("id", p.submission_id)
        .single()

      const prev = (curSub?.review_status ?? null) as ReviewStatus | null
      // A client re-editing from an ALREADY-resubmitted state must stay
      // 'resubmitted' (2026-08-03). This branch used to fall through to
      // 'submitted' for anything that wasn't 'revision_requested', and nothing
      // here checked the state machine — `resubmitted → submitted` is not a
      // legal transition. It only became reachable when 'resubmitted' was made
      // client-editable (the freeze fix): the client edits again, and the
      // history silently records a forbidden hop that erases the fact they had
      // already been round once. Staying put is both legal and truthful.
      const nextStatus: ReviewStatus =
        prev === "revision_requested" || prev === "resubmitted" ? "resubmitted" : "submitted"

      if (nextStatus === prev) {
        // Already there — write nothing. A self-transition is not in the state
        // machine either, and a history entry saying resubmitted → resubmitted
        // is noise in the one record that is supposed to be the truth.
        result.steps.push(step("review_status", "ok", `already ${prev} — unchanged`))
      } else {
        const reviewHistory = Array.isArray(curSub?.review_history) ? curSub!.review_history : []
        reviewHistory.push(
          buildReviewHistoryEntry({
            from: prev,
            to: nextStatus,
            at: now,
            by: p.contact_id ? `client:${p.contact_id}` : "portal",
          }),
        )

        const { error: rsErr } = await supabaseAdmin
          .from("tax_return_submissions")
          .update({ review_status: nextStatus, review_history: reviewHistory, updated_at: now })
          .eq("id", p.submission_id)

        if (rsErr) result.steps.push(step("review_status", "error", rsErr.message))
        else result.steps.push(step("review_status", "ok", `review_status → ${nextStatus}`))
      }
    } catch (e) {
      result.steps.push(step("review_status", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  // ─── 10. NOTIFY — staff "What's New" card + client portal message ───
  // Both helpers are non-fatal + idempotent by contract.
  if (p.account_id && p.submission_id) {
    const card = await emitActionNeeded({
      event: "tax_wizard_submitted",
      account_id: p.account_id,
      contact_id: p.contact_id,
      source_ref: `tax_submission:${p.submission_id}`,
    })
    result.steps.push(step("staff_card", card.created ? "ok" : "skipped", card.reason ?? "What's New card created"))
  }
  if (p.submission_id && (p.contact_id || p.account_id)) {
    const chat = await emitClientChatEvent({
      contact_id: p.contact_id,
      account_id: p.account_id,
      topic: "tax_review",
      message: `We've received your tax information${taxYear ? ` for ${taxYear}` : ""}. Our team will review it and let you know if anything needs changing.`,
      source: { table: "tax_return_submissions", id: p.submission_id },
      event_kind: "wizard_submitted",
    })
    result.steps.push(step("client_notice", chat.emitted ? "ok" : "skipped", chat.reason ?? "client chat event emitted"))
  }

  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `portal_wizard: ${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}

// ─── MCP apply_changes field maps ───

const contactFieldMap: Record<string, string> = {
  owner_first_name: "first_name",
  owner_last_name: "last_name",
  owner_email: "email",
  owner_phone: "phone",
  owner_country: "residency",
  owner_tax_residency: "citizenship",
}

const accountFieldMap: Record<string, string> = {
  llc_name: "company_name",
  ein_number: "ein_number",
  state_of_incorporation: "state_of_formation",
}

// ─── MCP apply_changes Workflow ───

async function handleMcpApplyChanges(job: Job, p: TaxFormPayload): Promise<JobResult> {
  const result: JobResult = { steps: [] }
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  const changes = p.changed_fields || {}
  const changeCount = Object.keys(changes).length

  // ─── 1. UPDATE CONTACT WITH CHANGED FIELDS ───
  if (p.contact_id && changeCount > 0) {
    try {
      const contactUpdates: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(changes)) {
        if (contactFieldMap[key]) contactUpdates[contactFieldMap[key]] = val.new
      }

      if (Object.keys(contactUpdates).length > 0) {
        // eslint-disable-next-line no-restricted-syntax
        const { error: upErr } = await supabaseAdmin
          .from("contacts")
          .update({ ...contactUpdates, updated_at: now })
          .eq("id", p.contact_id)

        if (upErr) {
          result.steps.push(step("contact_update", "error", upErr.message))
        } else {
          result.steps.push(step("contact_update", "ok", `Updated: ${Object.keys(contactUpdates).join(", ")}`))
        }
      } else {
        result.steps.push(step("contact_update", "skipped", "No contact fields changed"))
      }
    } catch (e) {
      result.steps.push(step("contact_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("contact_update", "skipped", changeCount === 0 ? "No changes" : "No contact_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 2. UPDATE ACCOUNT WITH CHANGED FIELDS ───
  if (p.account_id && changeCount > 0) {
    try {
      const accountUpdates: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(changes)) {
        if (accountFieldMap[key]) accountUpdates[accountFieldMap[key]] = val.new
      }

      if (Object.keys(accountUpdates).length > 0) {
        // eslint-disable-next-line no-restricted-syntax
        const { error: upErr } = await supabaseAdmin
          .from("accounts")
          .update({ ...accountUpdates, updated_at: now })
          .eq("id", p.account_id)

        if (upErr) {
          result.steps.push(step("account_update", "error", upErr.message))
        } else {
          result.steps.push(step("account_update", "ok", `Updated: ${Object.keys(accountUpdates).join(", ")}`))
        }
      } else {
        result.steps.push(step("account_update", "skipped", "No account fields changed"))
      }
    } catch (e) {
      result.steps.push(step("account_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("account_update", "skipped", changeCount === 0 ? "No changes" : "No account_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 3. UPDATE TAX RETURN → DATA RECEIVED ───
  if (p.tax_return_id) {
    try {
      const { error: trErr } = await supabaseAdmin
        .from("tax_returns")
        .update({
          data_received: true,
          data_received_date: today,
          status: "Data Received",
          updated_at: now,
        })
        .eq("id", p.tax_return_id)

      if (trErr) {
        result.steps.push(step("tax_return_update", "error", trErr.message))
      } else {
        result.steps.push(step("tax_return_update", "ok", "Tax return → Data Received"))
      }
    } catch (e) {
      result.steps.push(step("tax_return_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("tax_return_update", "skipped", "No tax_return_id"))
  }

  // ─── 4. ADVANCE SERVICE DELIVERY TO "Data Received" ───
  if (p.account_id) {
    try {
      const { data: sdRecord } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, stage, stage_order, stage_history")
        .eq("account_id", p.account_id)
        .eq("service_type", "Tax Return Filing")
        .eq("status", "active")
        .limit(1)
        .maybeSingle()

      if (sdRecord) {
        const history = Array.isArray(sdRecord.stage_history) ? sdRecord.stage_history : []
        history.push({
          from_stage: sdRecord.stage,
          from_order: sdRecord.stage_order,
          to_stage: "Data Received",
          to_order: 5,
          advanced_at: now,
          notes: "Client submitted tax form (auto-advanced by tax_form_setup)",
        })

        // eslint-disable-next-line no-restricted-syntax
        const { error: sdErr } = await supabaseAdmin
          .from("service_deliveries")
          .update({
            stage: "Data Received",
            stage_order: 5,
            stage_entered_at: now,
            stage_history: history,
          })
          .eq("id", sdRecord.id)

        if (sdErr) {
          result.steps.push(step("sd_advance", "error", sdErr.message))
        } else {
          result.steps.push(step("sd_advance", "ok", `SD ${sdRecord.id} → Data Received (stage 5)`))
        }
      } else {
        result.steps.push(step("sd_advance", "skipped", "No active Tax Return Filing SD found"))
      }
    } catch (e) {
      result.steps.push(step("sd_advance", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 5. EMAIL NOTIFICATION TO SUPPORT ───
  try {
    let companyName = p.token
    if (p.account_id) {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("company_name")
        .eq("id", p.account_id)
        .single()
      if (acc) companyName = acc.company_name
    }

    const { gmailPost } = await import("@/lib/gmail")

    const subject = `Tax Form Completed: ${companyName}`
    const body = [
      `The tax data collection form for ${companyName} has been submitted by the client.`,
      ``,
      `Token: ${p.token}`,
      `Changes: ${changeCount} field(s) modified by client`,
      ``,
      `Review: tax_form_review(token="${p.token}")`,
      `Admin Preview: ${APP_BASE_URL}/tax-form/${p.token}?preview=td`,
    ].join("\n")

    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const mimeHeaders = [
      `From: Tony Durante LLC <support@tonydurante.us>`,
      `To: support@tonydurante.us`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      `Content-Type: text/plain; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
    ]
    const rawEmail = [...mimeHeaders, "", Buffer.from(body).toString("base64")].join("\r\n")
    const encodedRaw = Buffer.from(rawEmail).toString("base64url")

    await gmailPost("/messages/send", { raw: encodedRaw })
    result.steps.push(step("email_notification", "ok", `Notified support@ about ${companyName}`))
  } catch (e) {
    result.steps.push(step("email_notification", "error", e instanceof Error ? e.message : String(e)))
  }

  await updateJobProgress(job.id, result)

  // ─── 6. MARK FORM AS REVIEWED ───
  if (!p.submission_id) {
    result.steps.push(step("form_reviewed", "skipped", "No submission_id"))
  } else {
    try {
      const { error: formErr } = await supabaseAdmin
        .from("tax_return_submissions")
        .update({
          status: "reviewed",
          reviewed_at: now,
          reviewed_by: p.source === "portal_wizard" ? "portal_auto" : "claude",
        })
        .eq("id", p.submission_id)

      if (formErr) {
        result.steps.push(step("form_reviewed", "error", formErr.message))
      } else {
        result.steps.push(step("form_reviewed", "ok", "Form → reviewed"))
      }
    } catch (e) {
      result.steps.push(step("form_reviewed", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `mcp_apply_changes: ${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}

// ─── Main Entry Point ───

export async function handleTaxFormSetup(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as TaxFormPayload

  if (p.source === "portal_wizard") {
    return handlePortalWizardTaxSetup(job, p)
  }

  return handleMcpApplyChanges(job, p)
}
