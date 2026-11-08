/**
 * POST /api/closure-form-completed
 *
 * Called by the closure form frontend after the client submits.
 * Auto-chain per Company Closure SOP:
 *
 * 1. Validate submission
 * 2. File the data PDF + documents. WHERE is decided by what the client wrote in the wizard (company name + EIN) checked against the
 *    job's own company link (lib/forms/closure-destination.ts): a company of ours -> that company's storage; another company -> the
 *    person's storage, folder "Company closure_<name>" (Company Closure Part B, Antonio 2026-11-06).
 * 3. Ensure Service Delivery exists
 * 3b. Move the job from "Data Collection" to "State Compliance Check" by itself (only from Data Collection — never re-advances; not when the
 *     wizard created the job, not when the client wrote another company than the job's, not twice for the same submission content —
 *     lib/closure/wizard-move-guard.ts)
 * 4. (no email to support any more — the What's New note is the only notification, Antonio 2026-11-05)
 * 5. Create task for Luca on a genuine RESUBMISSION only
 * 5b. What's New note for staff
 * 6. Add a note on the service delivery
 * 7. Log everything (action_log)
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint -- only triggers internal notifications)
 */

// Added 2026-04-14 P0.7: protect the 7-step auto-chain from mid-execution
// Vercel timeout (storage filing + PDF + email + task + SD ensure + history + log).
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWriteSafe } from "@/lib/db"
import { createSD, advanceStageIfAt } from "@/lib/operations/service-delivery"
import type { ClosureDestination } from "@/lib/forms/closure-destination"
import type { FilingStep } from "@/lib/forms/file-form-package"
import type { Json } from "@/lib/database.types"
import { reportSystemError } from "@/lib/system-errors"
import { decideClosureWhatsNew, shouldReportSwallowedResubmission } from "@/lib/portal/closure-whats-new"
import { wizardMoveNote, wizardAlreadyMovedJob, decideWizardMove, CHECK_CLEARED_MARKER } from "@/lib/closure/wizard-move-guard"

export async function POST(req: NextRequest) {
  const passStartedAt = new Date()
  try {
    const body = await req.json()
    const { submission_id, token, service_delivery_id: explicitServiceDeliveryId, dedupe_key: dedupeKey } = body as {
      submission_id?: string
      token?: string
      service_delivery_id?: string | null
      dedupe_key?: string | null
    }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    // 1. Get submission
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("closure_submissions")
      .select("*")
      .eq("id", submission_id)
      .eq("token", token)
      .single()

    if (subErr || !sub) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 })
    }

    // dev job fbbf4abe (Senior Engineer finding): once staff have reviewed a
    // submission, its own status is deliberately kept at "reviewed" — not
    // reset back to "completed" — through any later resubmission, precisely
    // so a correction never erases the fact it was already looked at once
    // (preserveReviewedStatus, lib/portal/submission-record.ts). Rejecting
    // "reviewed" here as "Form not completed" meant the FIRST correction a
    // client made after any review permanently failed this auto-chain — no
    // email, no task, no Drive save, ever again, for that submission. Both
    // statuses mean the client actually finished the form; "reviewed" is a
    // later, ADDITIONAL stage on top of "completed", never a replacement for
    // needing the auto-chain to run.
    if (sub.status !== "completed" && sub.status !== "reviewed") {
      return NextResponse.json({ error: "Form not completed" }, { status: 400 })
    }

    // dev job fbbf4abe (Senior Engineer finding): a stale/forwarded link to an
    // explicit record that staff have since cancelled or completed must be
    // REFUSED, never silently fall through to creating a brand-new SD — that
    // would resurrect a matter staff already closed out. Only the NEW,
    // server-verified explicit-id path can distinguish this; the legacy
    // account/contact-based lookup below has no id to check status against
    // and is left exactly as it was for the old emailed-link flow.
    // The job's own explicit company link (when the caller names the job): the cross-check for where the package is filed.
    let explicitJobAccountId: string | null = null
    if (explicitServiceDeliveryId) {
      const { data: explicitSd } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, status, account_id")
        .eq("id", explicitServiceDeliveryId)
        .maybeSingle()
      if (!explicitSd || explicitSd.status !== "active") {
        return NextResponse.json(
          { error: "This closure is no longer active — it may have already been completed or cancelled." },
          { status: 409 },
        )
      }
      explicitJobAccountId = (explicitSd.account_id as string | null) ?? null
    }

    const results: Array<{ step: string; status: string; detail?: string }> = []
    const submittedData = (sub.submitted_data || {}) as Record<string, unknown>
    const uploadPaths = (sub.upload_paths || []) as string[]
    const leadId = sub.lead_id as string | null
    const contactId = sub.contact_id as string | null
    const accountId = sub.account_id as string | null

    // Get client name
    let clientName = String(submittedData.owner_name || submittedData.owner_first_name || "")
    if (submittedData.owner_last_name) clientName += ` ${submittedData.owner_last_name}`
    if (!clientName.trim()) {
      if (leadId) {
        const { data: lead } = await supabaseAdmin.from("leads").select("full_name").eq("id", leadId).single()
        clientName = lead?.full_name || token
      } else if (contactId) {
        const { data: contact } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contactId).single()
        clientName = contact?.full_name || token
      }
    }
    clientName = clientName.trim() || token

    const llcName = String(submittedData.llc_name || "Unknown LLC")
    const llcState = String(submittedData.llc_state || (sub as Record<string, unknown>).state || "N/A")

    // ---- STEP 2: File the data PDF + uploads ----
    // Stop-Drive S1a: the "Leads/{client} - {llc} (Closure)" Drive folder is gone. A company that still has a Drive folder keeps
    // filing there (the storage gate inside saveFormToDrive redirects a switched one); everyone else is filed in their storage —
    // the company's if it has one, else the person's. Every missing file is an error step plus a staff alarm (fileFormPackage).
    // Company Closure Part B (Antonio 2026-11-06): what the client WROTE (company name + EIN) decides where the package goes, checked against
    // the job's own company link (the submission's, else the named job's). Both agree on one of the person's companies -> that company's
    // storage; anything else -> the PERSON's storage, folder "Company closure_<name>" (a disagreement is never guessed — staff are told below).
    const linkedAccountId = accountId ?? explicitJobAccountId
    let targetFolderId: string | null = null
    let destination: ClosureDestination | null = null
    let filing: FilingStep | null = null
    try {
      const { resolveClosureDestination, keepFirstFolderName } = await import("@/lib/forms/closure-destination")
      destination = await resolveClosureDestination({ linkedAccountId, contactId, clientName, submittedData })
      // A correction (the client re-sends) must not change where the package already is: the saver keeps it in the folder its summary was
      // first filed in, so the folder name the first pass pinned wins — the job's note and the pinned plan then name the folder that exists.
      const priorFolder = (sub.drive_archive_meta as { pinned_plan?: { storeRootSubFolder?: string } } | null)?.pinned_plan?.storeRootSubFolder
      destination = { ...destination, storeRootSubFolder: keepFirstFolderName(priorFolder, destination.storeRootSubFolder) }
      targetFolderId = destination.folderId
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      results.push({ step: "storage_save", status: "error", detail })
      const { raisePilotAlarm } = await import("@/lib/crm-store/formation-pilot")
      await raisePilotAlarm("lead_form_filing_failed", { route: "closure-form-completed", formType: "closure", token, contactId, accountId, problems: [detail] })
    }
    if (targetFolderId) {
      const { fileFormPackage } = await import("@/lib/forms/file-form-package")
      const { isWizardUploadPath } = await import("@/lib/portal/wizard-uploads")
      filing = await fileFormPackage({
        route: "closure-form-completed", formType: "closure", submittedData, uploadPaths, accountId, contactId, personName: clientName,
        driveFolderId: targetFolderId,
        storeRootSubFolder: destination?.storeRootSubFolder,
        // two upload origins: the external form (closure-uploads) and the portal wizard (onboarding-uploads) — same rule as the archive recipe
        bucket: "closure-uploads",
        resolveBucket: (path) => (isWizardUploadPath(path) ? "onboarding-uploads" : "closure-uploads"),
        meta: { token, submittedAt: sub.completed_at || new Date().toISOString(), companyName: llcName },
      })
      results.push(filing)

      // Durable backstop (2026-07-26): the inline save above is best-effort (as are the review + MCP re-saves). Enqueue the
      // reliable archive job with the plan PINNED (the SAME destination we just resolved) so a slow/failed copy self-heals via
      // retry, and the sweep alerts if it never lands.
      try {
        const { enqueueFormArchiveJob } = await import("@/lib/forms/archive-enqueue")
        const { deriveUploadPaths } = await import("@/lib/forms/archive-registry")
        await enqueueFormArchiveJob({
          formType: "closure",
          submissionId: sub.id,
          pin: {
            folderId: targetFolderId,
            bucket: "closure-uploads",
            configKey: "closure",
            uploadPaths: deriveUploadPaths(uploadPaths, submittedData),
            companyName: llcName,
            ...(destination?.storeRootSubFolder ? { storeRootSubFolder: destination.storeRootSubFolder } : {}),
          },
          createdBy: "closure_form_completed",
        })
      } catch (e) {
        results.push({ step: "archive_enqueue", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ---- STEP 3: Ensure Service Delivery exists ----
    let deliveryId: string | null = null
    // Tracks which branch below fired, so step 5 only creates its own plain
    // task on a RESUBMISSION — createSD's own dispatch (dispatchWorkflowForSdCreated)
    // already creates a proper workflow task card the moment a NEW SD is
    // created, so unconditionally also inserting the plain task below produced
    // two tasks for one event (AI architect finding, dev job fbbf4abe).
    let sdWasNewlyCreated = false
    let sdCreatedFromThisSubmission = false
    try {
      // dev job fbbf4abe root-cause fix: when the caller (the portal wizard,
      // via wizard-submit's server-side verification) already knows exactly
      // WHICH record this is, use that directly — it is unambiguous by
      // construction and sidesteps every account/contact/token heuristic
      // below entirely, closing the multi-LLC conflation at its actual
      // source rather than patching the heuristics that caused it. The
      // legacy lookup remains the fallback for the OLD emailed-link flow,
      // which has no explicit id to send.
      let existingSd: { id: string; source_closure_token?: string | null }[] | null = null
      if (explicitServiceDeliveryId) {
        existingSd = [{ id: explicitServiceDeliveryId }]
      } else if (accountId) {
        // Account-linked: one CRM account is one company, so account_id alone
        // is already an exact, unambiguous match — unchanged (Senior Engineer
        // confirmed this scoping is correct as-is).
        const { data } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, source_closure_token")
          .eq("service_type", "Company Closure")
          .eq("account_id", accountId)
          .eq("status", "active")
          .limit(1)
        existingSd = data
      } else if (contactId) {
        // Contact-only (no CRM account, an untracked external LLC): matching by
        // contact_id ALONE would treat a genuinely different LLC closed by the
        // same person as a resubmission of an unrelated one — the multi-LLC
        // conflation both reviewers found on the independent post-build check.
        // source_closure_token (this form submission's own token, one per
        // closure, see scripts/migrations/20260826-1400-closure-sd-dedup-unique.sql)
        // is what actually identifies WHICH closure this is; contact_id alone
        // never did. A pre-existing row from before this column existed has
        // source_closure_token NULL and no recoverable token (confirmed
        // against the one known real case: notes never got the
        // "Auto-created from closure form <token>" text this route writes,
        // because that record was never actually created by this route's own
        // "new SD" branch). Matching a NULL token too keeps that one legacy
        // shape working; it does NOT reopen the multi-LLC conflation, because
        // every row created FROM NOW ON always gets a real, distinct token —
        // two new closures for the same contact can never both be NULL.
        //
        // dev job 77b66080: a closure created at PAYMENT from a formation
        // contract (source_offer_token set, source_closure_token NULL) must
        // never be adopted by a token-less legacy submission — it could be for a
        // DIFFERENT old LLC. The NULL branch therefore also requires
        // source_offer_token IS NULL (the one hand-made legacy shape).
        const { data } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, source_closure_token")
          .eq("service_type", "Company Closure")
          .eq("contact_id", contactId)
          .or(`source_closure_token.eq.${token},and(source_closure_token.is.null,source_offer_token.is.null)`)
          .is("account_id", null)
          .eq("status", "active")
          .limit(1)
        existingSd = data
      }

      if (existingSd?.length) {
        deliveryId = existingSd[0].id
        // A retry of the pass that CREATED this SD from this very submission
        // (legacy link): createSD's note already announced it (step 5b).
        sdCreatedFromThisSubmission = existingSd[0].source_closure_token === token
      } else {
        // A legacy (token-less) submission is about to create a NEW closure SD
        // while a payment-created one already exists for this person — likely
        // the same old LLC. Created anyway (it can't be safely merged), but
        // staff must know (dev job 77b66080).
        if (!explicitServiceDeliveryId && !accountId && contactId) {
          const { data: offerClosure } = await supabaseAdmin
            .from("service_deliveries")
            .select("id, source_offer_token")
            .eq("service_type", "Company Closure")
            .eq("contact_id", contactId)
            .is("account_id", null)
            .eq("status", "active")
            .not("source_offer_token", "is", null)
            .limit(1)
          if (offerClosure?.length) {
            reportSystemError({
              source: "server",
              route: "/api/closure-form-completed",
              method: "POST",
              message: `closure form for ${clientName} (${llcName}) created a SECOND closure next to the one created at payment from offer ${offerClosure[0].source_offer_token} — check for a duplicate`,
              context: { submission_id, existingSdId: offerClosure[0].id },
            }).catch(() => {})
          }
        }
        const newSd = await createSD({
          service_type: "Company Closure",
          service_name: `Company Closure - ${llcName}`,
          account_id: accountId,
          contact_id: contactId,
          notes: `Auto-created from closure form ${token}`,
          source_closure_token: token,
        })
        deliveryId = newSd.id
        sdWasNewlyCreated = true
        results.push({ step: "sd_created", status: "ok", detail: `SD auto-created: ${deliveryId}` })
      }
    } catch (e) {
      results.push({ step: "sd_check", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ---- STEP 3b: move the job on by itself (Company Closure Part B; Antonio 2026-11-05/06: "the job moves after the wizard") ----
    // The wizard IS the first step's whole job ("Data Collection" waits for the client). Only FROM that step: a job staff already moved, a
    // resubmission or a mechanical retry of this pass never re-advances or moves a job backwards. No auto-tasks — the job's current step on
    // the Calendar IS the to-do. The client is told nothing about the move (Antonio 2026-11-06: no step notice).
    // NOT for a job THIS wizard created (E2E QA 2026-11-06: a stale link to a cancelled closure created a brand-new job that jumped to the
    // next step although nobody had paid for it): that job stays on Data Collection with the What's New note, for staff to check first.
    // Also NOT when the company the client wrote is not the one the job is linked to (E2E QA 2026-11-07: a corrected form for one company sent
    // through the person's OTHER open closure moved THAT job forward), and NOT a second time for the same submission content (a retry after
    // staff pressed Go Back undid it one second later). lib/closure/wizard-move-guard.ts.
    if (deliveryId) {
      const moveNote = wizardMoveNote(token, dedupeKey)
      let alreadyMoved = false
      if (!(sdWasNewlyCreated || sdCreatedFromThisSubmission)) {
        const { data: hist, error: histErr } = await supabaseAdmin.from("service_deliveries").select("stage_history").eq("id", deliveryId).maybeSingle()
        // unreadable → treat as "already moved": a missed move is visible to staff and cheap, an undone Go Back is not
        alreadyMoved = histErr ? true : wizardAlreadyMovedJob((hist as { stage_history?: unknown } | null)?.stage_history, moveNote)
      }
      const decision = decideWizardMove({
        createdByWizard: sdWasNewlyCreated || sdCreatedFromThisSubmission,
        companyDisagreement: destination?.disagreement ?? null,
        alreadyMovedForThisContent: alreadyMoved,
      })
      if (!decision.move) {
        results.push({ step: "sd_advance", status: "skipped", detail: decision.reason ?? undefined })
      } else {
        try {
          const adv = await advanceStageIfAt({
            delivery_id: deliveryId,
            if_current_stage: "Data Collection",
            target_stage: "State Compliance Check",
            actor: "closure-form-completed",
            notes: moveNote,
            skip_tasks: true,
            skip_notify: true,
          })
          if (adv.advanced) {
            results.push({ step: "sd_advance", status: "ok", detail: `SD ${deliveryId} -> State Compliance Check` })
          } else if (adv.current_stage === "Data Collection") {
            // the gate matched but the move itself failed — an error step, so the job retries it
            results.push({ step: "sd_advance", status: "error", detail: adv.result?.error || adv.reason })
          } else {
            // already moved forward (staff, an earlier pass, a resubmission): nothing to do
            results.push({ step: "sd_advance", status: "skipped", detail: adv.reason })
          }
        } catch (e) {
          results.push({ step: "sd_advance", status: "error", detail: e instanceof Error ? e.message : String(e) })
        }
      }
    }

    // ---- STEP 3c: show the client's files on the JOB (E2E QA 2026-11-06: the job's Documents box said "0 documents" while the files sat in Storage) ----
    // Staff-only rows (never shown to the client), no step stamp (so "Go Back" cannot delete them), idempotent.
    if (deliveryId && filing?.status === "ok" && targetFolderId) {
      try {
        const { registerClosurePackageDocuments } = await import("@/lib/forms/closure-documents")
        const reg = await registerClosurePackageDocuments({
          storageOwnerId: destination?.storageOwnerId ?? null,
          token,
          contactId,
          // a company is stamped on the files only when the package really is with that company (both checks agreed); otherwise the company's
          // document list would show papers about another company
          accountId: destination?.kind === "company" ? linkedAccountId : null,
          serviceDeliveryId: deliveryId,
        })
        results.push({ step: "documents_register", status: "ok", detail: `${reg.registered} file(s) listed on the job` })
      } catch (e) {
        results.push({ step: "documents_register", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ---- STEP 4: NO email to support any more (Antonio 2026-11-05: "the only notification is What's New") ----
    // The detailed "[TASK] New Closure Request" email to support@ is gone; the What's New note (step 5b) and the job's own workspace carry
    // everything. The step name is kept so the job's step list and the action log read the same as before.
    results.push({ step: "luca_email", status: "skipped", detail: "No email to support any more — the What's New note is the only notification" })

    // When the wizard's company and the job's link disagree the package was filed in the person's folder (never a company's): tell staff
    // what to check, with the same staff-visible channel this route already uses for "check for a duplicate".
    if (destination?.disagreement) {
      reportSystemError({
        source: "server",
        route: "/api/closure-form-completed",
        method: "POST",
        message: `closure form for ${clientName} (${llcName}): ${destination.disagreement}`,
        context: { submission_id, delivery_id: deliveryId, contact_id: contactId },
      }).catch(() => {})
      results.push({ step: "destination_check", status: "skipped", detail: destination.disagreement })
    }

    // ---- STEP 5: no plain "Start closure" to-do (Antonio, 2026-11-06) ----
    // This step used to insert a plain To-Do for Luca on every resubmitted / existing job. Antonio decided everything happens in the
    // Calendar: the job itself moves (step 3) and staff see it there, the What's New note (5b) and the staff-only team note (step 6)
    // carry the news. `isGenuineChange` (the submission's own content hash, forwarded unchanged from wizard-submit) is still what
    // tells a client's real correction apart from a mechanical retry of the same content, so 5b and the hash stamp keep using it.
    const isGenuineChange = !dedupeKey || sub.last_processed_hash !== dedupeKey
    results.push({ step: "luca_task", status: "skipped", detail: "no plain to-do by design — the job moves in the Calendar" })

    // ---- STEP 5b: What's New note for staff (Antonio, 2026-09-24) ----
    // Closure submissions used to produce only the email + task above —
    // nothing in What's New. Resubmission-aware via the same content hash as
    // step 5: a genuine change AFTER a previously processed pass retires the
    // old note and posts a fresh "resubmitted" one; a mechanical retry of
    // identical content just re-emits, which the marker dedup makes a no-op.
    // Must run BEFORE the hash stamp below (it reads the PRIOR hash).
    const whatsNew = decideClosureWhatsNew({
      sdWasNewlyCreated,
      sdCreatedFromThisSubmission,
      dedupeKey,
      priorHash: sub.last_processed_hash as string | null,
      isGenuineChange,
    })
    try {
      const { emitClosureWizardSubmittedEvent, retireClosureWizardSubmittedNote } = await import("@/lib/portal/chat-events")
      let retiredCount = 0
      if (whatsNew.retireFirst) {
        const r = await retireClosureWizardSubmittedNote({ closureSubmissionId: submission_id })
        retiredCount = r.retired
      }
      const ev = await emitClosureWizardSubmittedEvent({
        closure_submission_id: submission_id,
        contact_id: contactId,
        account_id: accountId,
        llc_name: llcName === "Unknown LLC" ? null : llcName,
        llc_state: llcState === "N/A" ? null : llcState,
        is_resubmission: whatsNew.isResubmission,
      })
      // A failed note is reported (system_errors), not returned as "error". The old reason — a retry of the pass re-sent the step-4 staff email —
      // is gone with the email; a retry would now only repeat idempotent steps, so this is a choice, not a necessity (the What's New note is the
      // ONLY notification now: a failed one is still visible to staff in the error log).
      // missing_recipient is expected for a lead-only legacy submission (no
      // contact/account yet → no staff thread to post into); not an error.
      // Also report a resubmission whose old note could not be retired: the
      // emit then dedups against it and staff get no fresh alert — unless the
      // surviving note was posted DURING this pass by a concurrent run, in
      // which case staff were alerted and reporting would be a false alarm.
      let survivingNoteCreatedAt: string | null = null
      if (whatsNew.retireFirst && retiredCount === 0 && ev.reason === "already_emitted" && ev.message_id) {
        const { data: surviving } = await supabaseAdmin
          .from("portal_messages")
          .select("created_at")
          .eq("id", ev.message_id)
          .maybeSingle()
        survivingNoteCreatedAt = (surviving?.created_at as string | null) ?? null
      }
      const resubmissionSwallowed = shouldReportSwallowedResubmission({
        retireFirst: whatsNew.retireFirst,
        retiredCount,
        emitReason: ev.reason,
        survivingNoteCreatedAt,
        passStartedAt,
      })
      if (resubmissionSwallowed || (!ev.emitted && ev.reason !== "already_emitted" && ev.reason !== "missing_recipient")) {
        reportSystemError({
          source: "server",
          route: "/api/closure-form-completed",
          method: "POST",
          message: `closure What's New note not posted for submission ${submission_id}: ${ev.reason ?? ""} ${ev.error ?? ""}`.trim(),
          context: {
            submission_id,
            ...(resubmissionSwallowed ? { blocking_note_id: ev.message_id ?? null, blocking_note_created_at: survivingNoteCreatedAt } : {}),
          },
        }).catch(() => {})
      }
      results.push({
        step: "whats_new",
        status: ev.emitted ? "ok" : "skipped",
        detail: ev.emitted ? `note ${ev.message_id}` : `not posted: ${ev.reason ?? ev.error ?? "unknown"}`,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      reportSystemError({
        source: "server",
        route: "/api/closure-form-completed",
        method: "POST",
        message: `closure What's New note threw for submission ${submission_id}: ${msg}`,
        context: { submission_id },
      }).catch(() => {})
      results.push({ step: "whats_new", status: "skipped", detail: `not posted: ${msg}` })
    }

    // Stamp the content hash AFTER deciding step 5 above, so a genuine retry
    // of a step that failed further down (Drive/email/SD-update) still gets
    // its normal retry behavior on those steps — only the task-creation
    // decision reads this value. Non-blocking: a failed stamp just means the
    // next retry re-evaluates isGenuineChange against the OLD hash, which is
    // still correct (worst case, one extra correctly-deduped retry).
    if (dedupeKey) {
      // supabase-js resolves with { error } rather than throwing, so a bare
      // try/catch here never actually catches a failed write (dev job
      // 9a9c5cf5 — this exact shape let last_processed_hash silently never
      // get set for days after a missing-column deploy, defeating the
      // isGenuineChange dedup above on every retry). Still deliberately
      // non-blocking, but the failure must be visible.
      const { error: hashErr } = await supabaseAdmin
        .from("closure_submissions")
        .update({ last_processed_hash: dedupeKey })
        .eq("id", submission_id)
      if (hashErr) {
        console.error('[closure-form-completed] last_processed_hash write failed:', hashErr.message)
        reportSystemError({
          source: 'server',
          route: '/api/closure-form-completed',
          method: 'POST',
          message: `closure_submissions.last_processed_hash write failed for submission ${submission_id}: ${hashErr.message}`,
          context: { submission_id, dedupe_key: dedupeKey },
        }).catch(() => {})
      }
    }

    // ---- STEP 6: notes on the job ----
    // where the package went, in plain words — for the STAFF note and the log only
    const filedWhere = !targetFolderId || filing?.status === "error"
      ? "(NOT filed — see the alarm)"
      : filing?.status === "pending"
        ? "(still being filed — the retry job finishes it)"
        : destination?.storeRootSubFolder
          ? `in the person's folder "${destination.storeRootSubFolder}"`
          : "in the company's storage"
    if (deliveryId) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, notes")
          .eq("id", deliveryId)
          .single()

        if (sd) {
          // The job's `notes` are shown to the CLIENT (portal service page, Progress card): keep this line neutral — no folder names, no
          // "check this" text (bug hunt 2026-11-06). Once per day, so a retry of the same pass does not repeat it.
          const line = `${new Date().toISOString().split("T")[0]}: Closure form completed. Data filed.`
          if (!(sd.notes || "").includes(line)) {
            await dbWriteSafe(
              // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw service_deliveries.update; extract to lib/operations/ per dev_task fda76fd3
              supabaseAdmin
                .from("service_deliveries")
                .update({ notes: (sd.notes || "") + `\n${line}`, updated_at: new Date().toISOString() })
                .eq("id", sd.id),
              "service_deliveries.update"
            )
          }
          results.push({ step: "sd_update", status: "ok" })
        }
      } catch (e) {
        results.push({ step: "sd_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // The STAFF detail — where the package went, and the "check this" line when the two checks disagreed — goes to the Calendar's team notes
      // (staff-only table, never shown to a client). Not repeated by a retry of the same pass.
      try {
        const body = `Closure wizard: package filed ${filedWhere}.${destination?.disagreement ? ` CHECK: ${destination.disagreement}` : ""}`
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_notes is not in the generated types yet (lib/job-notes/read.ts)
        const notes = supabaseAdmin as any
        const { data: same } = await notes.from("service_delivery_notes").select("id").eq("service_delivery_id", deliveryId).eq("body", body).limit(1)
        if (!same || same.length === 0) {
          const { error: noteErr } = await notes.from("service_delivery_notes").insert({ service_delivery_id: deliveryId, body, author_name: "Closure wizard" })
          if (noteErr) throw new Error(noteErr.message)
        }
        // The client's answers name the right company now: a CHECK line left by an earlier, wrong submission is stale — supersede it, or the
        // finish question keeps showing the old red warning (production 2026-11-08).
        if (!destination?.disagreement) {
          const { checkNoteFrom } = await import("@/lib/operations/close-company")
          const { data: checks } = await notes.from("service_delivery_notes").select("body").eq("service_delivery_id", deliveryId).ilike("body", "%CHECK%").order("created_at", { ascending: false }).limit(10)
          if (checkNoteFrom((checks ?? []) as Array<{ body: string | null }>)) {
            const { error: clearErr } = await notes.from("service_delivery_notes").insert({ service_delivery_id: deliveryId, body: `Closure wizard: ${CHECK_CLEARED_MARKER} the client now wrote ${llcName}, which matches the company this job is linked to.`, author_name: "Closure wizard" })
            if (clearErr) throw new Error(clearErr.message)
          }
        }
        results.push({ step: "staff_note", status: "ok" })
      } catch (e) {
        // a note must never fail the pass (its retry would only repeat idempotent steps): reported, not an error
        results.push({ step: "staff_note", status: "skipped", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ---- STEP 7: Log action ----
    try {
      await dbWriteSafe(
        supabaseAdmin.from("action_log").insert({
          action_type: "closure_form_completed",
          table_name: "closure_submissions",
          record_id: submission_id,
          summary: `Closure form completed: ${llcName} (${clientName}). Files ${filedWhere}; job moved on if it was waiting for the wizard.`,
          details: { token, lead_id: leadId, contact_id: contactId, account_id: accountId, results } as unknown as Json,
        }),
        "action_log.insert"
      )
    } catch { /* non-blocking */ }

    // eslint-disable-next-line no-console
    console.log(`[closure-form-completed] ${llcName}: ${results.length} steps. ${results.filter(r => r.status === "ok").length} ok`)

    return NextResponse.json({ ok: true, results })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[closure-form-completed] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
