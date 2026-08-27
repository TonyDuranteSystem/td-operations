/**
 * POST /api/tax-form-completed
 *
 * Called by the tax form frontend after the client submits.
 * Auto-chain per Tax Return SOP:
 *
 * 1. Update contact (only changed fields)
 * 2. Check passport for one-time customers
 * 3. Send detailed email to team (support@)
 * 4. Update tax_returns status -> Data Received
 * 5. Advance SD -> Data Received
 * 6. Save complete data PDF + uploads to Drive (3. Tax/{year}/)
 * 7. Auto P&L for MMLLC (parse bank statements)
 * 8. Create task for team
 * 9. Update SD history
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

// Added 2026-04-14 P0.7: protect the 9-step auto-chain from mid-execution
// Vercel timeout (CRM update + passport check + email + tax_returns advance +
// SD advance + Drive save + P&L parse + task + history).
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import { advanceStageIfAt } from "@/lib/operations/service-delivery"
import { dispatchWorkflowForFormCompletion } from "@/lib/tasks/dispatch-workflow-for-event"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"
import { APP_BASE_URL } from "@/lib/config"
import { emitActionNeeded } from "@/lib/notifications/act-event"
import { emitClientChatEvent } from "@/lib/portal/chat-events"
import { buildReviewHistoryEntry, type ReviewStatus } from "@/lib/tax/review-status"
import { resolveLocale, WIZARD_SUBMITTED_MESSAGE } from "@/lib/jobs/wizard-failure-notify"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { submission_id, token } = body as { submission_id?: string; token?: string }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from("tax_return_submissions")
      .select("id, token, account_id, contact_id, tax_year, entity_type, status, review_status")
      .eq("id", submission_id)
      .eq("token", token)
      .single()

    if (subErr || !sub) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 })
    }

    if (sub.status !== "completed") {
      return NextResponse.json({ error: "Form not completed" }, { status: 400 })
    }

    // A submission whose chain already ran (review_status written by step 4C)
    // must not be re-processed: a late sweep refire or duplicate trigger would
    // resend the team email and REGRESS an in-flight review (under_review →
    // submitted re-enables client editing). 'revision_requested' stays
    // allowed — the one state where a legitimate resubmission arrives with
    // the marker already set.
    if (sub.review_status && sub.review_status !== "revision_requested") {
      return NextResponse.json({ ok: true, skipped: "already_processed", review_status: sub.review_status })
    }

    const results: { step: string; status: string; detail?: string }[] = []

    // Get company name
    let companyName = token
    if (sub.account_id) {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("company_name")
        .eq("id", sub.account_id)
        .single()
      if (acc) companyName = acc.company_name
    }

    // ─── 0A. UPDATE CONTACT (only changed fields) ───
    if (sub.contact_id) {
      try {
        const { data: fullSub0 } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("submitted_data")
          .eq("id", submission_id)
          .single()
        const sd0 = (fullSub0?.submitted_data || {}) as Record<string, unknown>

        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("phone, residency, citizenship")
          .eq("id", sub.contact_id)
          .single()

        if (contact) {
          const updates: Record<string, unknown> = {}
          if (sd0.owner_phone && sd0.owner_phone !== contact.phone) updates.phone = sd0.owner_phone
          if (sd0.owner_tax_residency && sd0.owner_tax_residency !== contact.citizenship) updates.citizenship = sd0.owner_tax_residency

          const newAddr = [sd0.owner_street, sd0.owner_city, sd0.owner_state_province, sd0.owner_zip, sd0.owner_country].filter(Boolean).join(", ")
          if (newAddr && newAddr !== contact.residency) updates.residency = newAddr

          if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString()
            await dbWrite(
              // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 contacts.update; extract to lib/operations/contact.ts per dev_task fda76fd3
              supabaseAdmin.from("contacts").update(updates).eq("id", sub.contact_id),
              "contacts.update"
            )
            results.push({ step: "contact_update", status: "ok", detail: `Updated: ${Object.keys(updates).filter(k => k !== "updated_at").join(", ")}` })
          } else {
            results.push({ step: "contact_update", status: "skipped", detail: "No changes detected" })
          }
        }
      } catch (e) {
        results.push({ step: "contact_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 0B. CHECK PASSPORT FOR ONE-TIME CUSTOMERS ───
    if (sub.account_id) {
      try {
        const { data: acc0 } = await supabaseAdmin
          .from("accounts")
          .select("account_type")
          .eq("id", sub.account_id)
          .single()

        if (acc0?.account_type === "One-Time" && sub.contact_id) {
          const { data: contact0 } = await supabaseAdmin
            .from("contacts")
            .select("passport_on_file")
            .eq("id", sub.contact_id)
            .single()

          if (contact0 && !contact0.passport_on_file) {
            const { data: contactInfo } = await supabaseAdmin
              .from("contacts")
              .select("full_name, email")
              .eq("id", sub.contact_id)
              .single()

            await dbWriteSafe(
              // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 tasks.insert (passport missing); extract to lib/operations/task per dev_task fda76fd3
              supabaseAdmin.from("tasks").insert({
                task_title: `[MISSING] Request passport from ${contactInfo?.full_name || "client"} (${companyName})`,
                description: `One-time client ${companyName} submitted tax form but has NO passport on file.\nEmail ${contactInfo?.email || "client"} to request a clear passport scan.\nPassport is required for tax return filing.`,
                assigned_to: defaultTaskAssignee(),
                priority: "Urgent",
                category: "Document",
                status: "To Do",
                due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
                account_id: sub.account_id,
                contact_id: sub.contact_id,
                created_by: "System",
              }),
              "tasks.insert"
            )
            results.push({ step: "passport_check", status: "missing", detail: "One-time client, no passport on file. Urgent task created." })
          } else {
            results.push({ step: "passport_check", status: "ok", detail: "Passport on file" })
          }
        } else {
          results.push({ step: "passport_check", status: "skipped", detail: "Annual client (passport already on file)" })
        }
      } catch (e) {
        results.push({ step: "passport_check", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 1. DETAILED EMAIL TO TEAM ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const { data: fullSubEmail } = await supabaseAdmin
        .from("tax_return_submissions")
        .select("submitted_data, upload_paths")
        .eq("id", submission_id)
        .single()

      const sd = (fullSubEmail?.submitted_data || {}) as Record<string, unknown>
      const uploads = (fullSubEmail?.upload_paths || []) as string[]

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[TASK] Tax Form Completed - ${companyName} (${sub.tax_year})</h2>
<p>Client <strong>${companyName}</strong> has submitted the tax data collection form for ${sub.tax_year}.</p>

<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Entity type:</td><td style="padding:4px 8px">${sub.entity_type}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Revenue reported:</td><td style="padding:4px 8px">${sd.total_revenue || sd.gross_revenue || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Expenses reported:</td><td style="padding:4px 8px">${sd.total_expenses || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Bank accounts used:</td><td style="padding:4px 8px">${sd.bank_accounts_used || sd.banks_used || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Documents uploaded:</td><td style="padding:4px 8px">${uploads.length} files</td></tr>
</table>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Next Steps (per Tax Return SOP v4.0)</h3>
<ol>
<li>Review data: <code>tax_form_review(token="${sub.token}")</code></li>
<li>If complete, apply changes: <code>tax_form_review(token="${sub.token}", apply_changes=true)</code></li>
${(sub.entity_type === "MMLLC" || sub.entity_type === "Corp") ? `<li>⚠ Statements are NOT auto-ingested on this (external form) path — ingest deliberately: <code>bank_statement_process(account_id="${sub.account_id}", tax_year=${sub.tax_year})</code>, then review: <code>bank_statement_review(account_id="${sub.account_id}")</code></li>
<li>Generate P&L: <code>bank_statement_pnl(account_id="${sub.account_id}", tax_year=${sub.tax_year})</code></li>` : ""}
<li>Check if 2nd installment is paid (Stage 6 gate)</li>
<li>When ready, send to accountant: <code>tax_send_to_accountant(account_id="${sub.account_id}", tax_year=${sub.tax_year})</code></li>
</ol>

<p style="font-size:12px;color:#6b7280">Token: ${sub.token} | Admin: ${APP_BASE_URL}/tax-form/${sub.token}?preview=td</p>
</div>`

      const taxSubject = `[TASK] Tax Form Completed - ${companyName} (${sub.tax_year})`
      const encodedSubject = `=?utf-8?B?${Buffer.from(taxSubject).toString("base64")}?=`
      const raw = Buffer.from(
        `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
        `To: support@tonydurante.us\r\n` +
        `Subject: ${encodedSubject}\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n` +
        emailBody
      ).toString("base64url")

      await gmailPost("/messages/send", { raw })
      results.push({ step: "email_notification", status: "ok", detail: `Detailed email sent to support@ (team)` })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── 2. UPDATE SERVICE DELIVERY HISTORY ───
    if (sub.account_id) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_order, stage_history, service_type")
          .eq("account_id", sub.account_id)
          .or("service_type.eq.Tax Return,service_type.eq.Tax Return Filing")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (sd) {
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "tax_form_submitted",
            at: new Date().toISOString(),
            note: `Tax form submitted by client for ${companyName} (${sub.tax_year})`,
          })

          await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 service_deliveries.update (stage_history); extract to lib/operations/service-delivery per dev_task fda76fd3
            supabaseAdmin
              .from("service_deliveries")
              .update({ stage_history: history })
              .eq("id", sd.id),
            "service_deliveries.update"
          )

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history (stage: ${sd.stage})` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Tax Return Filing SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 3. CREATE REVIEW TASK FOR TEAM (catalog-driven dispatch) ───
      //
      // Slice 8 Pass 6: workflow choice is data-driven. The dispatcher
      // scans task_workflows rows whose triggered_by matches this submission
      // (table=tax_return_submissions). Today only tax_form_review matches.
      // Adding a future tax variant = duplicate the row with a different
      // filter — no edit to this route.
      const workflowTaskTitle = `Review tax form data -- ${companyName} (${sub.tax_year})`

      const dispatch = await dispatchWorkflowForFormCompletion({
        form_table: "tax_return_submissions",
        submission: { ...sub },
        build_task_meta: async () => ({
          submission_id: sub.id,
          account_id: sub.account_id,
          contact_id: sub.contact_id ?? null,
          tax_year: sub.tax_year,
          entity_type: sub.entity_type,
          token: sub.token,
          company_name: companyName,
        }),
        task_title: workflowTaskTitle,
        description: `Client ${companyName} has submitted tax data for ${sub.tax_year}. Entity type: ${sub.entity_type}. Review the data, then click Approve & Apply Changes to enqueue the CRM reconciliation job.`,
        account_id: sub.account_id,
        contact_id: sub.contact_id ?? null,
        actor: "tax-form-completed:auto-chain",
        idempotency: { field: "submission_id", value: sub.id },
      })

      if (dispatch.spawned) {
        results.push({
          step: "review_task",
          status: "ok",
          detail: `Workflow ${dispatch.workflow_slug} task ${dispatch.task_id}`,
        })
      } else if (dispatch.reason === "already_spawned") {
        // Webhook retry — treat as success, do NOT fall through to legacy.
        results.push({
          step: "review_task",
          status: "skipped",
          detail: `Workflow task already exists for submission ${sub.id} (task ${dispatch.task_id})`,
        })
      } else {
        if (dispatch.reason === "ambiguous") {
          console.warn(
            `[tax-form-completed] AMBIGUOUS workflow match (${dispatch.candidates?.join(", ")}) — falling back to legacy plain task. Fix catalog data.`,
          )
        } else if (dispatch.reason === "meta_invalid" || dispatch.reason === "spawn_failed") {
          console.warn(
            `[tax-form-completed] dispatch failed (${dispatch.reason}): ${dispatch.meta_error ?? dispatch.spawn_error}`,
          )
        }
        // Legacy fallback below.
        try {
          const { data: existingTask } = await supabaseAdmin
            .from("tasks")
            .select("id")
            .eq("task_title", workflowTaskTitle)
            .eq("account_id", sub.account_id)
            .maybeSingle()

          if (!existingTask) {
            await dbWriteSafe(
              // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 legacy fallback plain task; extract to lib/operations/ per dev_task fda76fd3
              supabaseAdmin.from("tasks").insert({
                task_title: workflowTaskTitle,
                description: [
                  `Client ${companyName} has submitted tax data for ${sub.tax_year}.`,
                  ``,
                  `Entity type: ${sub.entity_type}`,
                  `Review: tax_form_review(token="${sub.token}")`,
                  `Action: Review data completeness, then apply_changes=true to update CRM.`,
                ].join("\n"),
                assigned_to: defaultTaskAssignee(),
                priority: "High",
                category: "Tax" as never,
                status: "To Do",
                account_id: sub.account_id,
                created_by: "System",
              }),
              "tasks.insert"
            )
            results.push({ step: "review_task", status: "ok", detail: `${workflowTaskTitle} (legacy fallback)` })
          } else {
            results.push({ step: "review_task", status: "skipped", detail: "Already exists" })
          }
        } catch (e) {
          results.push({ step: "review_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
        }
      }
    }

    // ─── 4. (DEFERRED) tax_returns advance moved to client Confirm ───
    // Slice 2 (review workflow): submitting no longer flips tax_returns to
    // "Data Received". That happens only when the client confirms after staff
    // review (review_status → confirmed) via the confirm route. The submission
    // enters the review loop instead (review_status set in STEP 4C below).
    if (sub.account_id) {
      results.push({ step: "tax_return_status", status: "skipped", detail: "Deferred to client confirm (review workflow)" })
    }

    // ─── 4B. MOVE SD → "Data Submitted" (review block, not Data Received) ───
    // The SD parks at the single "Data Submitted" macro stage for the whole
    // review; review_status tracks the sub-state; only the client's Confirm
    // releases it forward. Gate stays permissive (legacy + current pre-review
    // stages); strict target validation lives in advanceStageIfAt.
    if (sub.account_id) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id")
          .eq("account_id", sub.account_id)
          .eq("service_type", "Tax Return")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (sd) {
          const advanceResult = await advanceStageIfAt({
            delivery_id: sd.id,
            // "1st Installment Paid" / "2nd Installment Paid" REMOVED from the
            // from-list (PTBT fix, dev job 8cc8e1c8): a completed legacy form
            // must not drag a pre-wizard SD into review — that jump skips the
            // 2nd-installment billing gate. Legacy staff-sent links for clients
            // at those stages now leave the SD untouched (skipped silently).
            if_current_stage: ["Data Link Sent", "Activated", "Wizard Available"],
            target_stage: "Data Submitted",
            actor: "tax-form-completed",
            notes: `Tax form submitted by client (${sub.tax_year}) — entering review`,
            skip_tasks: true,
          })
          if (advanceResult.advanced) {
            results.push({ step: "sd_advance", status: "ok", detail: `SD ${sd.id} -> Data Submitted` })
          } else if (advanceResult.current_stage && advanceResult.result?.error) {
            results.push({ step: "sd_advance", status: "error", detail: advanceResult.result.error })
          }
          // Otherwise skipped silently (gate not met)
        }
      } catch (e) {
        results.push({ step: "sd_advance", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 4C. SET review_status + notify (Slice 2) ───
    let reviewStatusPriorToThisSubmission: ReviewStatus | null = null
    {
      try {
        const prev = sub.review_status ?? null
        reviewStatusPriorToThisSubmission = prev as ReviewStatus | null
        // Same rule as the portal handler (2026-08-03): a re-submit from an
        // already-'resubmitted' state STAYS there. Falling through to
        // 'submitted' writes a transition the state machine forbids and erases
        // the fact that the client had already been round once.
        const nextStatus: ReviewStatus =
          prev === "revision_requested" || prev === "resubmitted" ? "resubmitted" : "submitted"
        if (nextStatus === prev) {
          results.push({ step: "review_status", status: "ok", detail: `already ${prev} — unchanged` })
        } else {
          const { data: curSub } = await supabaseAdmin
            .from("tax_return_submissions")
            .select("review_history")
            .eq("id", submission_id)
            .single()
          const reviewHistory = Array.isArray(curSub?.review_history) ? curSub!.review_history : []
          reviewHistory.push(
            buildReviewHistoryEntry({
              from: (prev as ReviewStatus | null),
              to: nextStatus,
              at: new Date().toISOString(),
              by: sub.contact_id ? `client:${sub.contact_id}` : "tax-form",
            }),
          )
          await supabaseAdmin
            .from("tax_return_submissions")
            .update({ review_status: nextStatus, review_history: reviewHistory, updated_at: new Date().toISOString() })
            .eq("id", submission_id)
          results.push({ step: "review_status", status: "ok", detail: `review_status -> ${nextStatus}` })
        }
      } catch (e) {
        results.push({ step: "review_status", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      if (sub.account_id) {
        const card = await emitActionNeeded({
          event: "tax_wizard_submitted",
          account_id: sub.account_id,
          contact_id: sub.contact_id,
          source_ref: `tax_submission:${submission_id}`,
        })
        results.push({ step: "staff_card", status: card.created ? "ok" : "skipped", detail: card.reason ?? "What's New card created" })
      }
      if (sub.contact_id || sub.account_id) {
        const locale = await resolveLocale(sub.contact_id ?? null, sub.account_id ?? null)
        // A non-null prior review_status means this row already went through
        // this exact notify step once — this pass is a genuine resubmission,
        // not the first submission. Retire the old marker first so the dedup
        // check in emitClientChatEvent doesn't silently swallow the new note
        // (dev job fbbf4abe follow-up — same class of bug already fixed for
        // banking).
        if (reviewStatusPriorToThisSubmission !== null) {
          const { retireWizardSubmittedNote } = await import("@/lib/portal/chat-events")
          await retireWizardSubmittedNote({ taxReturnSubmissionId: submission_id })
        }
        const chat = await emitClientChatEvent({
          contact_id: sub.contact_id,
          account_id: sub.account_id,
          topic: "tax_review",
          message: WIZARD_SUBMITTED_MESSAGE[locale](sub.tax_year ?? null),
          source: { table: "tax_return_submissions", id: submission_id },
          event_kind: "wizard_submitted",
        })
        results.push({ step: "client_notice", status: chat.emitted ? "ok" : "skipped", detail: chat.reason ?? "client chat event emitted" })
      }
    }

    // ─── 5. SAVE FORM DATA + UPLOADS TO DRIVE ───
    if (sub.account_id) {
      try {
        const { data: fullSub } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("submitted_data, upload_paths, completed_at")
          .eq("id", submission_id)
          .single()

        const { data: acc } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", sub.account_id)
          .single()

        if (fullSub?.submitted_data && acc?.drive_folder_id) {
          const { saveFormToDrive } = await import("@/lib/form-to-drive")
          // The submission's files live in whichever bucket they were uploaded
          // to: the PORTAL wizard uses "onboarding-uploads" with a "tax/{id}/…"
          // path scheme; the EXTERNAL public tax form (this route's actual
          // caller) uploads to the "tax-form-uploads" config default with a
          // "{slug}-{year}/…" scheme. Pick by path prefix — same rule as
          // tax_form_review. A hardcoded "onboarding-uploads" here made every
          // external Drive copy fail (0 files) since 2026-06-12.
          const uploadPaths = (fullSub.upload_paths as string[]) || []
          const portalUpload = uploadPaths.some(p => p.startsWith("tax/"))
          const driveResult = await saveFormToDrive(
            "tax_return",
            fullSub.submitted_data as Record<string, unknown>,
            uploadPaths,
            acc.drive_folder_id,
            { token: sub.token, submittedAt: fullSub.completed_at || new Date().toISOString(), companyName, year: sub.tax_year },
            portalUpload ? { bucket: "onboarding-uploads" } : undefined
          )
          if (driveResult.summaryFileId) {
            results.push({ step: "drive_save", status: "ok", detail: `Summary: ${driveResult.summaryFileId}, ${driveResult.copied.length} files copied` })

            // Same registration as the portal path (card c5ff8b4d) — the
            // external form's questionnaire PDF must also become a real
            // client-visible company document.
            const { registerOrganizerDocument } = await import("@/lib/tax/register-organizer-document")
            const { data: taxSd } = await supabaseAdmin
              .from("service_deliveries")
              .select("id")
              .eq("account_id", sub.account_id)
              .or("service_type.eq.Tax Return,service_type.eq.Tax Return Filing")
              .eq("status", "active")
              .limit(1)
              .maybeSingle()
            const reg = await registerOrganizerDocument({
              accountId: sub.account_id,
              driveFileId: driveResult.summaryFileId,
              companyName,
              taxYear: sub.tax_year,
              serviceDeliveryId: taxSd?.id ?? null,
            })
            results.push({ step: "organizer_document", status: reg.registered ? "ok" : "error", detail: reg.registered ? "Tax questionnaire registered (client-visible)" : `not registered: ${reg.reason}` })
          }
          if (driveResult.errors.length > 0) {
            results.push({ step: "drive_save", status: "error", detail: driveResult.errors.join(", ") })
          }
        } else {
          results.push({ step: "drive_save", status: "skipped", detail: `No data or no drive_folder_id` })
        }
      } catch (e) {
        results.push({ step: "drive_save", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 5. (REMOVED 2026-08-12) Legacy Drive statement scrape + auto P&L ───
    // The twin of the tax_form_setup scrape died with it (card 4a39e0fd;
    // Antonio's ruling: Drive is archive-only — no machine reads files into
    // the books invisibly). This copy had drifted further (pattern missed
    // Chase, scanned only the Tax root, never the year subfolder). External
    // submissions get NO automatic statement ingestion: the external form's
    // `financial_statements` upload is a MIXED bag (any financial document),
    // so auto-parsing it into the books would be guessing. Staff ingest
    // deliberately via the review tools / the tax workspace instead.
    if ((sub.entity_type === "MMLLC" || sub.entity_type === "Corp") && sub.account_id) {
      results.push({
        step: "bank_statement_parse",
        status: "skipped",
        detail: "Automatic Drive ingestion removed (2026-08-12) — statements are ingested only through the reviewed pipeline; staff add files deliberately.",
      })
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[tax-form-completed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
