/**
 * Job Handler Registry — maps job_type to handler functions.
 * Add new job types here as the system grows.
 */

import type { Job, JobResult } from "./queue"
import { handleOnboardingSetup } from "./handlers/onboarding-setup"
import { handleFormationSetup } from "./handlers/formation-setup"
import { handleTaxFormSetup } from "./handlers/tax-form-setup"
import { handleTaxReturnIntake } from "./handlers/tax-return-intake"
import { handleWelcomePackagePrepare } from "./handlers/welcome-package-setup"
import { handleItinWizardSetup } from "./handlers/itin-wizard-setup"
import { handleDocumentReprocess } from "./handlers/document-reprocess"
import { handleInvoiceReminder } from "./handlers/invoice-reminder"
import { handleIngestBankStatement } from "./handlers/ingest-bank-statement"
import { handleIngestWorkspaceStatement } from "./handlers/ingest-workspace-statement"
import { handleRecategorizeAi } from "./handlers/recategorize-ai"
import { handleRecategorizeWorkspaceAi } from "./handlers/recategorize-workspace-ai"
import { handleCountryPolicySweep } from "./handlers/country-policy-sweep"
import { handleEsignSendEmail } from "./handlers/esign-send-email"
import { handleArchiveTaxSubmission } from "./handlers/archive-tax-submission"
import { handleArchiveSubmission } from "./handlers/archive-submission"
import { handleTranslateLanguage } from "./handlers/translate-language"
import { handleClosureSetup } from "./handlers/closure-setup"

/** Runner-supplied execution context (Phase 3R): the hard wall-clock deadline
 *  anchored to the RUNNER's invocation start — a chunked handler must stop
 *  cleanly before it, never trusting its own start time (review cond. 1). */
export interface JobRunContext {
  deadlineAt?: number
}

type JobHandler = (job: Job, ctx?: JobRunContext) => Promise<JobResult>

const handlers: Record<string, JobHandler> = {
  onboarding_setup: handleOnboardingSetup,
  formation_setup: handleFormationSetup,
  tax_form_setup: handleTaxFormSetup,
  tax_return_intake: handleTaxReturnIntake,
  welcome_package_prepare: handleWelcomePackagePrepare,
  // Added 2026-04-14 P0.5 — portal ITIN wizard auto-chain.
  itin_wizard_setup: handleItinWizardSetup,
  // Added 2026-06-11 — OCR self-heal for docs shared while processing failed.
  document_reprocess: handleDocumentReprocess,
  // Added 2026-06-22 — batched overdue-invoice reminder sending (dunning).
  invoice_reminder: handleInvoiceReminder,
  // Added 2026-06-24 — per-file bank statement ingestion (CSV/PDF) for the
  // portal tax wizard; one job per statement keeps each inside the 300s window.
  ingest_bank_statement: handleIngestBankStatement,
  // Added 2026-07-01 — standalone P&L tool: per-file ingestion into an ISOLATED
  // workspace (pnl_workspace_transactions). Separate handler so the wizard's
  // ingest_bank_statement path stays untouched (wizard-safety principle).
  ingest_workspace_statement: handleIngestWorkspaceStatement,
  // Added 2026-06-26 — AI categorization refinement as a proper job. Was a
  // dangling promise inside ingestPortalCsv that outlived the HTTP response and
  // got the Vercel function torn down → upload returned a 500 to the client
  // even though ingestion succeeded. Now awaited inside the worker.
  recategorize_ai: handleRecategorizeAi,
  // Added 2026-07-02 — workspace twin of recategorize_ai, enqueued by the
  // Generate P&L action (one AI pass per generation, never on a partial set).
  recategorize_workspace_ai: handleRecategorizeWorkspaceAi,
  // Added 2026-07-06 (S4) — replays standing country policies after the AI
  // chain completes; enqueued by the chain's DONE branch.
  country_policy_sweep: handleCountryPolicySweep,
  // Added 2026-06-27 — e-sign signer-invite emails (durable, retried).
  esign_send_email: handleEsignSendEmail,
  // Added 2026-07-24 — durable Google-Drive archival of a tax submission,
  // split out of tax_form_setup so a slow/failed copy self-heals via retry
  // without re-sending the client emails. The backstop sweep re-enqueues any
  // submission left un-archived and raises the loud staff alert.
  archive_tax_submission: handleArchiveTaxSubmission,
  // Added 2026-07-24 — GENERIC durable Drive archival for the non-tax forms
  // (banking first, then formation/onboarding/itin/closure). Same reliability
  // contract as archive_tax_submission, driven by per-form recipes in
  // lib/forms/archive-registry.ts. Payload carries { form_type, table,
  // submission_id }. Tax keeps its own handler (left untouched).
  archive_submission: handleArchiveSubmission,
  // Added 2026-08-23 (dev job 12cab351) — chained AI translation of the
  // portal's UI text into a client-picked language. One chunk per invocation,
  // same shape as recategorize_ai; chains dictionary source -> wizard source.
  translate_language: handleTranslateLanguage,
  // Added 2026-08-26 (dev job fbbf4abe) — portal Company Closure wizard
  // auto-chain, converged onto the same implementation the older emailed-link
  // closure flow already uses (see handlers/closure-setup.ts doc comment).
  closure_setup: handleClosureSetup,
}

export function getJobHandler(jobType: string): JobHandler | null {
  return handlers[jobType] || null
}

export function getRegisteredJobTypes(): string[] {
  return Object.keys(handlers)
}
