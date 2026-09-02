/**
 * Job Handler: formation_setup
 *
 * Auto-chain for formation wizard submissions (Antonio's architectural model,
 * 2026-05-03/04). After this handler runs, the formation client has:
 * - Updated contact (DOB, address, passport_on_file)
 * - Contact-level Drive folder (Contacts/{Name}/) with passport uploaded
 * - "Company Formation" Service Delivery on the contact (no account_id)
 * - Email to support@, Luca WhatsApp task, portal notification
 *
 * What this handler does NOT do (deferred to Articles arrival):
 * - Create the CRM account
 * - Write members rows (data stays on formation_submissions.submitted_data)
 * - Upload additional MMLLC member passports to Drive
 * - Migrate the contact Drive folder to a company folder
 *
 * The materialization at Articles upload (PR 3) reads formation_submissions
 * to create account + account_contacts + members + Drive migration + SS-4.
 *
 * Triggered by:
 * 1. Portal wizard-submit (source: 'portal_wizard') — primary path
 * 2. MCP formation_form_review (source: undefined) — legacy admin path
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { createSD } from "@/lib/operations/service-delivery"
import { advanceServiceDelivery } from "@/lib/service-delivery"
import { updateJobProgress, type Job, type JobResult } from "../queue"
import { validateFormationData } from "../validation"
import { firstUploadPath } from "@/lib/portal/wizard-uploads"
import {
  decideFormationRun,
  type FormationDeliverySnapshot,
  type FormationRunDecision,
} from "@/lib/portal/formation-resubmit-gate"

interface FormationPayload {
  token: string
  submission_id: string | null
  contact_id: string | null
  lead_id: string | null
  submitted_data: Record<string, unknown>
  source?: "portal_wizard" | string
}

/**
 * Resolve the ORIGINATING OFFER token for this submission (dev job ca788354).
 *
 * `p.token` is a SUBMISSION token (`portal-{slug}-{year}-{scope8}`) — NOT an
 * offer token. Writing it into `source_offer_token` would look like a stamp
 * while breaking everything that reads that column: materialization matches it
 * against `offers` to link the new company (a miss leaves the client's portal
 * saying "Set up your new company" forever), and activation's duplicate check
 * keys on it (a miss lets a SECOND active formation through, which the partial
 * unique index cannot catch because the two rows carry different values).
 *
 * Returns null when it cannot be resolved. NEVER a fabricated value.
 */
async function resolveOfferToken(leadId: string | null): Promise<string | null> {
  if (!leadId) return null
  try {
    const { data, error } = await supabaseAdmin
      .from("offers")
      .select("token")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !data?.token) return null
    return String(data.token)
  } catch {
    return null
  }
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

/**
 * Which revision of THIS handler is running. Bump it whenever the handler's
 * behaviour changes (dev job ca788354).
 *
 * WHY THIS EXISTS. On 2026-08-10 the sandbox served the NEW portal pages and
 * the OLD compiled job handler at the same time — a stale build artifact. The
 * job dutifully created a "WhatsApp follow-up" task from a step that had been
 * deleted, and every job-level QA result taken that evening was quietly
 * meaningless. It looked like a passing test.
 *
 * Nothing in the job's own record said which code produced it, so "which
 * handler ran" was an INFERENCE. Now it is a FACT written into the step log:
 * read `build_identity` on any run before trusting what the other steps say.
 * The revision string proves the BUNDLE is fresh (it changes when this file
 * changes); the deployment id proves WHICH deployment served it.
 */
const HANDLER_REVISION = "ca788354-resubmit-gate-v1"

/** The build identity line, emitted as the FIRST step of every run. */
export function buildIdentityDetail(
  env: { deploymentId?: string; commitSha?: string } = {},
): string {
  const deployment = env.deploymentId || "local"
  const commit = env.commitSha ? env.commitSha.slice(0, 7) : "n/a"
  return `handler=${HANDLER_REVISION} deployment=${deployment} commit=${commit}`
}

export async function handleFormationSetup(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as FormationPayload
  const result: JobResult = { steps: [] }
  const now = new Date().toISOString()
  const submitted = p.submitted_data || {}

  // ─── 0a. BUILD IDENTITY — always first, even if everything else fails ───
  // So that "which code produced this result" is never inferred again.
  result.steps.push(step(
    "build_identity",
    "ok",
    buildIdentityDetail({
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA,
    }),
  ))

  // ─── 0. VALIDATE WIZARD DATA ───
  const validation = validateFormationData(submitted)
  if (!validation.valid) {
    const errDetail = validation.errors.map(e => `${e.field}: ${e.message}`).join("; ")
    result.steps.push(step("validation", "error", errDetail))
    result.summary = `Validation failed: ${validation.errors.length} error(s)`
    result.ok = false
    return result
  }
  result.steps.push(step("validation", "ok", "All checks passed"))

  // ─── 0b. RE-SUBMIT GATE (dev job ca788354) ───
  // Decide, BEFORE any write, whether this run may create a formation or is a
  // re-submit of one that is already finished. Keyed on the OFFER, never the
  // contact — ~11% of contacts own more than one company and a contact-keyed
  // refusal would strand a repeat client's new formation forever.
  const offerToken = await resolveOfferToken(p.lead_id)
  let decision: FormationRunDecision = {
    action: "create",
    reason: "first_run",
    allow: {
      contactUpdate: true,
      staffEmail: true,
      deliveryCreate: true,
      stageAdvance: true,
      clientNotification: true,
      formStatusWrite: true,
    },
  }

  if (p.contact_id) {
    const { data: sdRows, error: sdErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, stage, status, account_id, source_offer_token")
      .eq("contact_id", p.contact_id)
      .eq("service_type", "Company Formation")
      .limit(50)

    // Fail CLOSED, as the previous duplicate-check did (2026-07-20): a guard we
    // cannot trust must stop rather than wave a duplicate formation through.
    if (sdErr) {
      throw new Error(
        `formation duplicate-check failed (${sdErr.message}) — not creating, to avoid a duplicate formation`,
      )
    }

    const formations: FormationDeliverySnapshot[] = (sdRows ?? []).map((r) => ({
      id: String(r.id),
      stage: (r.stage as string | null) ?? null,
      status: (r.status as string | null) ?? null,
      hasAccount: r.account_id != null,
      sourceOfferToken: (r.source_offer_token as string | null) ?? null,
    }))

    // "Formation data received!" goes out once per formation, ever. A client
    // submitting twice in three seconds (Patrick Covelli, 2026-06-25) must not
    // be told twice; a run that died before notifying must still deliver it.
    let clientAlreadyNotified = false
    try {
      const { data: notified } = await supabaseAdmin
        .from("portal_notifications")
        .select("id")
        .eq("contact_id", p.contact_id)
        .eq("title", "Formation data received!")
        .limit(1)
      clientAlreadyNotified = !!notified && notified.length > 0
    } catch {
      // Unreadable: prefer a possible duplicate notification over silence.
      clientAlreadyNotified = false
    }

    decision = decideFormationRun({ offerToken, formations, clientAlreadyNotified })
  }

  if (decision.action === "refuse_finished") {
    result.steps.push(step(
      "formation_resubmit_refused",
      "skipped",
      `Formation ${decision.deliveryId ?? "(unknown)"} is already finished — no delivery, no stage advance, no client notification, form record untouched`,
    ))
  } else if (decision.action === "ambiguous") {
    result.steps.push(step(
      "formation_resubmit_refused",
      "skipped",
      "Could not identify which formation this submission belongs to — withheld all machinery and flagged staff",
    ))
  }

  /** Human-readable "old → new" lines for the fields this run changes. */
  const changedContactFields: string[] = []

  // ─── 1. UPDATE CONTACT WITH SUBMITTED DATA ───
  // Deliberately NOT gated by the re-submit decision: Antonio's ruling is that
  // a client's correction always reaches their record. Blocking it would mean a
  // corrected passport or date of birth vanishes behind a success message.
  if (p.contact_id) {
    try {
      const contactUpdates: Record<string, unknown> = {
        updated_at: now,
      }

      if (submitted.owner_first_name) contactUpdates.first_name = submitted.owner_first_name
      if (submitted.owner_last_name) contactUpdates.last_name = submitted.owner_last_name
      if (submitted.owner_email) contactUpdates.email = submitted.owner_email
      if (submitted.owner_phone) contactUpdates.phone = submitted.owner_phone
      if (submitted.owner_nationality) contactUpdates.citizenship = submitted.owner_nationality
      if (submitted.owner_dob) contactUpdates.date_of_birth = submitted.owner_dob

      // Dual-write address: structured fields (primary) + residency concat
      // (legacy readers). Same pattern as onboarding-setup / tax-return-intake.
      if (submitted.owner_street) contactUpdates.address_line1 = String(submitted.owner_street).trim()
      if (submitted.owner_city) contactUpdates.address_city = String(submitted.owner_city).trim()
      if (submitted.owner_state_province) contactUpdates.address_state = String(submitted.owner_state_province).trim()
      if (submitted.owner_zip) contactUpdates.address_zip = String(submitted.owner_zip).trim()
      if (submitted.owner_country) contactUpdates.address_country = String(submitted.owner_country).trim()
      const addrParts = [
        submitted.owner_street,
        submitted.owner_city,
        submitted.owner_state_province,
        submitted.owner_zip,
        submitted.owner_country,
      ].filter(Boolean).map(String).map(s => s.trim())
      if (addrParts.length > 1) {
        contactUpdates.residency = addrParts.join(', ')
      } else if (submitted.owner_country) {
        contactUpdates.residency = String(submitted.owner_country).trim()
      }

      // Mark passport as on file if uploaded (value may be a single path or an
      // array of paths — firstUploadPath handles both; empty array = none).
      if (firstUploadPath(submitted.passport_owner)) {
        contactUpdates.passport_on_file = true
      }

      // Capture WHICH fields this submission actually changes, so a refused
      // re-submit's staff email can show the overwrite rather than just
      // announcing one (Antonio, 2026-08-10). Read before the write; a failed
      // read must not block the write.
      try {
        const { data: before } = await supabaseAdmin
          .from("contacts")
          .select("*")
          .eq("id", p.contact_id)
          .maybeSingle()
        if (before) {
          for (const [k, v] of Object.entries(contactUpdates)) {
            if (k === "updated_at") continue
            const prev = (before as Record<string, unknown>)[k]
            if (String(prev ?? "") !== String(v ?? "")) {
              changedContactFields.push(`${k}: "${String(prev ?? "")}" → "${String(v ?? "")}"`)
            }
          }
        }
      } catch {
        // Diff is a reporting aid, never a gate.
      }

      const fieldCount = Object.keys(contactUpdates).filter(k => k !== "updated_at").length
      if (fieldCount > 0) {
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { error: upErr } = await supabaseAdmin
          .from("contacts")
          .update(contactUpdates)
          .eq("id", p.contact_id)

        if (upErr) {
          result.steps.push(step("contact_update", "error", upErr.message))
        } else {
          result.steps.push(step("contact_update", "ok", `${fieldCount} fields updated`))
        }
      } else {
        result.steps.push(step("contact_update", "skipped", "No contact fields to update"))
      }
    } catch (e) {
      result.steps.push(step("contact_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("contact_update", "skipped", "No contact_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 2. LEAD CONVERSION — SKIPPED (now happens at payment in whop webhook / check-wire-payments) ───
  result.steps.push(step("lead_converted", "skipped", "Moved to payment confirmation (Change 1.1)"))

  // ─── 2a. NO ACCOUNT CREATION AT WIZARD SUBMIT (Antonio's model, 2026-05-03/04) ───
  // The account is created when Articles of Organization arrive in Drive.
  // Until then, all data attaches to the contact, and member info stays on
  // formation_submissions.submitted_data. The materialization at Articles
  // upload reads the submission and creates account + account_contacts +
  // members + Drive migration + SS-4 fire in one atomic helper.
  //
  // See sysdoc 'ops-2026-05-03-formation-architecture-decision-and-plan'.
  const accountId: string | null = null
  result.steps.push(step(
    "account_create",
    "skipped",
    "Formation account deferred — created when Articles of Organization arrive in Drive",
  ))

  // ─── 2a.1. DRIVE FOLDER + PASSPORT PROCESSING ───
  // Phase 1: Create contact-level Drive folder (Contacts/{Name}/)
  // Documents will migrate to company folder when LLC name is selected (Phase 2)
  let contactDriveFolderId: string | null = null
  if (p.contact_id) {
    try {
      const { ensureContactFolder } = await import("@/lib/drive-folder-utils")
      const contactName = [submitted.owner_first_name, submitted.owner_last_name].filter(Boolean).join(" ") || p.token
      const folderResult = await ensureContactFolder(p.contact_id, contactName)
      contactDriveFolderId = folderResult.folderId

      if (folderResult.created) {
        result.steps.push(step("drive_folder", "ok", `Created: Contacts/${contactName}/`))
      } else {
        result.steps.push(step("drive_folder", "skipped", "Already exists"))
      }

      // Copy passport from Supabase Storage to Drive. File fields may now hold
      // multiple paths; the owner-passport OCR/Drive flow acts on the first one
      // (any extras remain in storage + upload_paths). dev_task 64bfcdd9.
      const passportPath = firstUploadPath(submitted.passport_owner)
      if (passportPath && contactDriveFolderId) {
        try {
          const contactsSubfolder = folderResult.subfolders["2. Contacts"]
          if (contactsSubfolder) {
            const cleanPath = passportPath.replace(/^\/+/, "")
            // Duplicate-upload guard (LT Program incident): a re-run of this
            // job must not add a second Drive copy. The prior run also did
            // the OCR writeback + documents insert, so skip the whole block.
            const dupCheckName = cleanPath.split("/").pop() || "passport.pdf"
            const { fileExistsInFolder } = await import("@/lib/google-drive")
            const dup = await fileExistsInFolder(contactsSubfolder, dupCheckName)
            if (dup.exists) {
              result.steps.push(step("passport_copy", "skipped", `Already on Drive (${dup.id})`))
            } else {
            const { data: blob, error: dlErr } = await supabaseAdmin.storage
              .from("onboarding-uploads")
              .download(cleanPath)

            if (dlErr || !blob) {
              result.steps.push(step("passport_copy", "error", dlErr?.message || "Download failed"))
            } else {
              const { uploadBinaryToDrive } = await import("@/lib/google-drive")
              const fileName = cleanPath.split("/").pop() || "passport.pdf"
              const buffer = Buffer.from(await blob.arrayBuffer())
              const mimeType = blob.type || "application/octet-stream"

              const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, contactsSubfolder) as { id: string; name: string }
              result.steps.push(step("passport_copy", "ok", `Uploaded to Drive: ${driveFile.id}`))

              // OCR + MRZ extraction — shared helper writes passport_number /
              // passport_expiry_date / date_of_birth to the contact and creates
              // a manual-entry task for unsupported formats (HEIC).
              const { extractAndStorePassportData } = await import("@/lib/jobs/passport-writeback")
              const passportResult = await extractAndStorePassportData({
                contact_id: p.contact_id!,
                drive_file_id: driveFile.id,
                mime_type: mimeType,
                skip_dob: !!submitted.owner_dob,
                contact_name: [submitted.owner_first_name, submitted.owner_last_name].filter(Boolean).join(" ") || p.token,
                account_id: accountId,
              })
              result.steps.push(step("passport_ocr", passportResult.status, passportResult.detail))

              // Create document record
              await supabaseAdmin.from("documents").insert({
                file_name: fileName,
                drive_file_id: driveFile.id,
                drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
                document_type_name: "Passport",
                category: 2,
                category_name: "Contacts",
                status: "classified",
                contact_id: p.contact_id,
                account_id: accountId,
                portal_visible: true,
              })
              result.steps.push(step("passport_doc_record", "ok", "Document record created"))
            }
            }
          } else {
            result.steps.push(step("passport_copy", "error", "No '2. Contacts' subfolder found"))
          }
        } catch (passErr) {
          result.steps.push(step("passport_copy", "error", passErr instanceof Error ? passErr.message : String(passErr)))
        }
      } else if (!passportPath) {
        result.steps.push(step("passport_copy", "skipped", "No passport uploaded"))
      }
    } catch (driveErr) {
      result.steps.push(step("drive_folder", "error", driveErr instanceof Error ? driveErr.message : String(driveErr)))
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 2b. MMLLC MEMBER PROCESSING DEFERRED (Antonio's model, 2026-05-03/04) ───
  // Additional MMLLC members are NOT processed here. Their data lives on
  // formation_submissions.submitted_data (member_first_name, member_email,
  // ownership_pct, etc.) and their passports stay in Supabase storage under
  // formation_submissions.upload_paths.
  //
  // The materialization at Articles upload (PR 3) reads the submission and:
  //   - creates a contact for each additional member (find-or-create by email)
  //   - inserts members rows on the new account
  //   - upserts account_contacts (Member role)
  //   - copies each member passport from storage → Drive
  //   - creates documents rows
  //
  // For SMLLC: nothing to defer — only the owner exists. The owner's contact
  // updates + passport + members row (if any) are handled at materialization.

  // ─── 2c. CREATE SERVICE DELIVERY (Company Formation pipeline, Stage 1: Payment Confirmed) ───
  try {
    const sdContactId = p.contact_id
    if (sdContactId) {
      // The existence question was already answered by the re-submit gate,
      // keyed on the OFFER (see step 0b). The old lookup here asked only
      // "any ACTIVE formation for this person", which missed every COMPLETED
      // one — 178 of 195 in production — and minted the phantom.
      let sdId: string | null = null
      let sdStage: string | null = null

      if (!decision.allow.deliveryCreate && decision.deliveryId) {
        const existing = (await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage")
          .eq("id", decision.deliveryId)
          .maybeSingle()).data
        sdId = decision.deliveryId
        sdStage = (existing?.stage as string | null) ?? null
        result.steps.push(step("service_delivery", "skipped", `Already exists at ${sdStage}: ${sdId}`))
      } else if (!decision.allow.deliveryCreate) {
        result.steps.push(step(
          "service_delivery",
          "skipped",
          decision.action === "ambiguous"
            ? "Formation could not be identified — no delivery created (staff flagged)"
            : "Formation already finished — no delivery created",
        ))
      } else {
        // SD is contact-only at wizard submit per Antonio's model. The first
        // candidate LLC name is appended to the SD name purely for human
        // readability in the CRM — it is NOT a commitment to that name. The
        // chosen name is recorded separately on wizard data via the LLC Name
        // Selection card; the SD's service_name is updated when the company
        // is materialized at Articles upload.
        const llcCandidate = String(submitted.llc_name_1 || "").trim()
        const sdName = llcCandidate ? `Company Formation - ${llcCandidate}` : "Company Formation"
        try {
          const sd = await createSD({
            service_type: "Company Formation",
            service_name: sdName,
            // Antonio's model: SD attaches to the buyer (contact) until/unless the company materializes.
            contact_id: sdContactId,
            account_id: null,
            // v2 Company Formation pipeline stage_order=1 (migration 20260617);
            // the old "Data Collection" stage no longer exists for this service.
            target_stage: "Payment Confirmed",
            target_stage_order: 1,
            start_date: now.slice(0, 10),
            // Traceability AND enforcement. Every other delivery on a client's
            // record names the offer it came from; the ones this handler made
            // named nothing, which is what made the Turcanu duplicate look like
            // a phantom. Stamping also ARMS the partial unique index
            // uq_formation_sd_active_per_offer, which could never apply while
            // the column was null. Explicitly null when unresolvable — never a
            // fabricated value (see resolveOfferToken).
            source_offer_token: offerToken,
            notes: `Created by formation_setup job ${job.id} from submission ${p.submission_id ?? "(none)"}.`,
          })
          sdId = sd.id
          sdStage = "Payment Confirmed"
          result.steps.push(step("service_delivery", "ok", `SD created: ${sd.id} (Payment Confirmed, contact-scoped)`))
        } catch (e) {
          // A unique violation means a concurrent run won the race (two
          // process-jobs invocations can overlap). Adopt the winner and carry
          // on to the stage advance — otherwise the race leaves the formation
          // stuck at "Payment Confirmed" while the job still reports green.
          const msg = e instanceof Error ? e.message : String(e)
          const isDuplicate = /duplicate key|23505|uq_formation_sd_active_per_offer/i.test(msg)
          if (isDuplicate && offerToken) {
            const { data: winner } = await supabaseAdmin
              .from("service_deliveries")
              .select("id, stage")
              .eq("contact_id", sdContactId)
              .eq("service_type", "Company Formation")
              .eq("source_offer_token", offerToken)
              .eq("status", "active")
              .limit(1)
              .maybeSingle()
            if (winner?.id) {
              sdId = String(winner.id)
              sdStage = (winner.stage as string | null) ?? null
              result.steps.push(step("service_delivery", "skipped", `Concurrent run won — adopted ${sdId} at ${sdStage}`))
            } else {
              result.steps.push(step("service_delivery", "error", msg))
            }
          } else {
            result.steps.push(step("service_delivery", "error", msg))
          }
        }
      }

      // ─── 2c-bis. ADVANCE Payment Confirmed → Wizard Submitted ───
      // This handler runs because the formation wizard was submitted, but the
      // SD is normally pre-created at "Payment Confirmed" by activate-service —
      // so the "already exists" branch above just skipped, leaving the SD stuck
      // at "Payment Confirmed" forever (Davide Priori, 2026-06-24). Advance it
      // now, but ONLY from "Payment Confirmed" and ONLY when the formation
      // wizard_progress is actually 'submitted'. The stage guard makes this
      // idempotent: a re-run finds the SD at "Wizard Submitted" (≠ "Payment
      // Confirmed") and does nothing, and an SD already past this stage is
      // never regressed.
      if (decision.allow.stageAdvance && sdId && sdStage === "Payment Confirmed") {
        const { data: submittedWp } = await supabaseAdmin
          .from("wizard_progress")
          .select("id")
          .eq("contact_id", sdContactId)
          .eq("wizard_type", "formation")
          .eq("status", "submitted")
          .limit(1)
          .maybeSingle()

        // FALLBACK (dev job 9a9c5cf5): a wizard_progress write can fail
        // silently for reasons unrelated to whether the client actually
        // submitted (the 2026-08-27 missing-column incident being one).
        // THIS job's own submission record (p.submission_id) is
        // independent proof the wizard was genuinely submitted — and,
        // unlike a contact-wide lookup, it can never cross-link a
        // DIFFERENT company's submission for a repeat client, because
        // it's pinned to the exact submission this job was dispatched
        // for.
        let hasProof = !!submittedWp
        if (!hasProof && p.submission_id) {
          const { data: fallbackSub } = await supabaseAdmin
            .from("formation_submissions")
            .select("id, status")
            .eq("id", p.submission_id)
            .in("status", ["completed", "reviewed"])
            .maybeSingle()
          hasProof = !!fallbackSub
        }

        if (hasProof) {
          try {
            const adv = await advanceServiceDelivery({
              delivery_id: sdId,
              target_stage: "Wizard Submitted",
              notes: "Formation wizard submitted",
            })
            result.steps.push(
              step(
                "service_delivery_advance",
                adv.success ? "ok" : "error",
                adv.success
                  ? `SD ${sdId} advanced: Payment Confirmed → Wizard Submitted`
                  : `Advance failed: ${adv.error}`,
              ),
            )
          } catch (e) {
            result.steps.push(step("service_delivery_advance", "error", e instanceof Error ? e.message : String(e)))
          }
        } else {
          result.steps.push(step("service_delivery_advance", "skipped", "Neither wizard_progress nor the formation_submissions fallback shows this submission as submitted yet"))
        }
      }
    } else {
      result.steps.push(step("service_delivery", "skipped", "No contact_id available"))
    }
  } catch (e) {
    result.steps.push(step("service_delivery", "error", e instanceof Error ? e.message : String(e)))
  }

  // ─── 2b. ITIN SERVICE DELIVERIES (start-at-wizard — dev_task fcf5e254) ───
  // ITIN is personal: it starts now, not when the company is formed. Creates a
  // contact-scoped ITIN SD for each person the client marked "applies for ITIN"
  // in the wizard (owner + members). No-op when the offer had no ITIN. This
  // closes the gap where bundled ITIN was silently dropped at activation.
  if (p.contact_id) {
    try {
      const { createItinDeliveriesFromWizard } = await import("@/lib/operations/itin-from-wizard")
      const itin = await createItinDeliveriesFromWizard({
        contactId: p.contact_id,
        leadId: p.lead_id,
        submitted,
        offerToken: p.token,
      })
      if (itin.created === 0 && itin.skipped === 0) {
        result.steps.push(step("itin_deliveries", "skipped", "No one applied for ITIN"))
      } else {
        result.steps.push(
          step(
            "itin_deliveries",
            "ok",
            `${itin.created} created, ${itin.skipped} existing — ${itin.people.map((x) => `${x.name}:${x.status}`).join(", ")}`,
          ),
        )
      }
    } catch (e) {
      result.steps.push(step("itin_deliveries", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  await updateJobProgress(job.id, result)

  // ─── 3. MARK FORM AS REVIEWED ───
  // A refused re-submit must NEVER reset the reviewed status or re-stamp the
  // original completion timestamps (Antonio, 2026-08-10). Daniel Janos Pasztor
  // submitted 2026-06-25 and his record came to read completed AND reviewed
  // 2026-07-12 — seventeen days adrift — because this ran unconditionally on
  // every re-run and the stable submission token made it the SAME row.
  if (!decision.allow.formStatusWrite) {
    result.steps.push(step(
      "form_reviewed",
      "skipped",
      "Re-submit withheld — original reviewed status and completion timestamps left untouched",
    ))
  } else if (!p.submission_id) {
    result.steps.push(step("form_reviewed", "skipped", "No submission_id"))
  } else {
  try {
    // Captured BEFORE this pass's own write, so it reflects whether a
    // PRIOR pass already reviewed this exact row (dev job 9a9c5cf5, round
    // 5) — mirrors tax-form-setup.ts's reviewStatusPriorToThisSubmission.
    // A non-null status here means this is a genuine resubmission of the
    // SAME row (stable token), not the row's first pass through this step.
    const { data: priorSub } = await supabaseAdmin
      .from("formation_submissions")
      .select("status")
      .eq("id", p.submission_id)
      .maybeSingle()
    const wasAlreadyReviewed = !!(priorSub?.status && priorSub.status !== "completed")

    const { error: formErr } = await supabaseAdmin
      .from("formation_submissions")
      .update({
        status: "reviewed",
        reviewed_at: now,
        // Portal wizard-submit (buildSubmissionRecord) writes status:"completed"
        // but never stamps completed_at, so the column stays NULL. Stamp it here
        // alongside the review flip. Same `now` as reviewed_at — the auto-chain
        // runs seconds after submission, so this ≈ submission time.
        completed_at: now,
        reviewed_by: p.source === "portal_wizard" ? "portal_auto" : "claude",
      })
      .eq("id", p.submission_id)

    if (formErr) {
      result.steps.push(step("form_reviewed", "error", formErr.message))
    } else {
      result.steps.push(step("form_reviewed", "ok", "Form → reviewed"))
    }

    // ─── 3b. STAFF WHAT'S NEW ALERT (dev job 9a9c5cf5, round 5) ───
    // Before this, formation had NO dedicated "client submitted the
    // wizard" event at all — staff relied entirely on the unconditional
    // email below and the ONE-TIME payment note, which is routinely
    // dismissed before the wizard is even started (real incident:
    // Francesco Lussignoli). Gated on formStatusWrite (already true in
    // this branch) so a refused/ambiguous re-submit — deliberately silent
    // by Antonio's ruling, dev job ca788354 — never fires this either.
    //
    // Deliberately NEVER retires an existing note here (bug-hunter finding,
    // round 6): `wasAlreadyReviewed` reflects this row's `status` column,
    // which this SAME job attempt just flipped to "reviewed" a few lines
    // up — so if a LATER step in this same pass throws (e.g. the
    // updateJobProgress call below hits a transient error) and the job
    // queue retries the whole handler, the retry would see `status`
    // already "reviewed" from its own prior (successful) attempt and
    // misread that as a genuine client resubmission — retiring the
    // correct, already-emitted note and replacing it with a false
    // "Client resubmitted..." one, plus re-stamping reviewed_at/
    // completed_at. Relying on emitClientChatEvent's own marker dedup
    // instead means a retry safely no-ops (reason: "already_emitted"),
    // and a GENUINE resubmission still gets counted — just without the
    // "resubmitted" wording variant, which needs a content-based signal
    // (not available for formation_submissions today) to do safely.
    if (!formErr && p.contact_id) {
      try {
        const { emitFormationWizardSubmittedEvent } = await import("@/lib/portal/chat-events")
        const chat = await emitFormationWizardSubmittedEvent({
          formation_submission_id: p.submission_id,
          contact_id: p.contact_id,
          is_resubmission: wasAlreadyReviewed,
        })
        result.steps.push(
          step("staff_whats_new_alert", chat.emitted ? "ok" : "skipped", chat.reason ?? "client chat event emitted"),
        )
      } catch (e) {
        result.steps.push(step("staff_whats_new_alert", "error", e instanceof Error ? e.message : String(e)))
      }
    }
  } catch (e) {
    result.steps.push(step("form_reviewed", "error", e instanceof Error ? e.message : String(e)))
  }
  } // end submission_id check

  await updateJobProgress(job.id, result)

  // ─── 4. EMAIL NOTIFICATION TO SUPPORT ───
  try {
    const clientName = submitted.owner_first_name
      ? `${submitted.owner_first_name} ${submitted.owner_last_name || ""}`
      : p.token

    const { gmailPost } = await import("@/lib/gmail")

    // The staff email is the ONLY channel that reports a withheld re-submit.
    // Antonio's ruling: the client is told nothing, so this must say plainly
    // that a finished formation was re-submitted AND show what it changed, so
    // the overwrite gets human review instead of passing unnoticed.
    const isRefused = decision.action === "refuse_finished"
    const isAmbiguous = decision.action === "ambiguous"

    const subject = isRefused
      ? `Re-submit of a FINISHED formation: ${clientName}`
      : isAmbiguous
        ? `Formation re-submit needs a decision: ${clientName}`
        : `Formation Form Completed: ${clientName}`

    const header = isRefused
      ? [
          `${clientName} RE-SUBMITTED the formation wizard for a formation that is already finished.`,
          ``,
          `Nothing was created: no new service delivery, no stage change, and the client was NOT notified.`,
          `Their form record keeps its original reviewed status and completion date.`,
          `Their contact record HAS been updated with what they submitted — please review the changes below.`,
        ]
      : isAmbiguous
        ? [
            `${clientName} re-submitted the formation wizard, and we could NOT identify which formation it belongs to.`,
            ``,
            `Nothing was created and the client was NOT notified — this needs a human decision.`,
            `If this is a NEW company, its service delivery must be created by hand.`,
            `Their contact record HAS been updated with what they submitted — please review the changes below.`,
          ]
        : [`Client ${clientName} has completed the formation data collection form.`]

    const changes = (isRefused || isAmbiguous)
      ? [
          ``,
          changedContactFields.length > 0
            ? `WHAT CHANGED ON THE CONTACT (${changedContactFields.length}):`
            : `WHAT CHANGED ON THE CONTACT: nothing — the submitted values match what was already on file.`,
          ...changedContactFields.map((c) => `  • ${c}`),
        ]
      : []

    const body = [
      ...header,
      ...changes,
      ``,
      `Token: ${p.token}`,
      `Email: ${submitted.owner_email || "N/A"}`,
      `LLC Names: ${submitted.llc_name_1 || "N/A"}`,
      ``,
      `Review: formation_form_review(token="${p.token}")`,
      `Admin Preview: ${APP_BASE_URL}/formation-form/${p.token}?preview=td`,
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
    result.steps.push(step("email_notification", "ok", `Notified support@ about ${clientName}`))
  } catch (e) {
    result.steps.push(step("email_notification", "error", e instanceof Error ? e.message : String(e)))
  }

  // ─── 5. (REMOVED) CRM TASK FOR LUCA — WhatsApp follow-up ───
  // Retired by Antonio, 2026-08-10 (dev job ca788354). Client contact goes
  // through portal chat; nothing replaces this step. All 19 tasks it ever
  // created were cancelled unactioned. The step is deleted rather than guarded
  // so no path can create one again.

  // ─── 6. PORTAL NOTIFICATION TO CONTACT ───
  // Once per formation, ever — and never at all for a withheld re-submit. This
  // fired on every run before: Pasztor and Covelli each received "Formation
  // data received!" three times, and Turcanu received it for a company formed
  // six weeks earlier.
  if (!decision.allow.clientNotification) {
    result.steps.push(step(
      "portal_notification",
      "skipped",
      decision.action === "create" || decision.action === "use_existing"
        ? "Client already notified for this formation"
        : "Re-submit withheld — client not notified",
    ))
  } else if (p.contact_id) {
    try {
      const { createPortalNotification } = await import("@/lib/portal/notifications")
      const llcName = String(submitted.llc_name_1 || "your LLC")
      await createPortalNotification({
        contact_id: p.contact_id,
        account_id: accountId || undefined,
        type: "service",
        title: "Formation data received!",
        body: `We received your information for ${llcName}. Our team will verify and begin the formation process.`,
        link: "/portal/services",
      })
      result.steps.push(step("portal_notification", "ok", "Contact notified in portal"))
    } catch (e) {
      result.steps.push(step("portal_notification", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
