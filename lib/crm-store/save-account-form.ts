/**
 * CRM Store — file a form's summary + uploaded files in a COMPANY's storage, keyed by the company (Stop Drive, dev job
 * 264bb882, slice S1c).
 *
 * `saveFormToDrive` (lib/form-to-drive.ts) finds the owner through a Drive folder id, so a company with no Drive folder
 * (every new client) had nowhere to be filed and the staff review tools printed "no folder — not saved". This helper asks the
 * company itself, and files through the same `saveFormToStore` the Drive path already uses (same folders, same idempotent keys).
 *
 *   store   → filed in the company's storage; result is the usual { summaryFileId, copied, failed, skipped, errors }.
 *   drive   → a company left on its old folder (no storage, a folder, not finished) is filed there through `saveFormToDrive`,
 *             exactly as before (`route: "folder"`); any other company: `{ route: "none" }` — the caller says so in the one plain sentence.
 *   moving  → throws CompanyMovingError (nothing may land anywhere while a move runs).
 */

import type { FormStoreResult } from "./save-form"
import { NO_STORAGE_SENTENCE } from "./no-storage"

/** store = filed in the company's storage; folder = filed in the old folder of a company left as it was; none = filed nowhere. */
export type SaveAccountFormResult = { route: "store" | "folder"; result: FormStoreResult } | { route: "none" }

export interface SaveAccountFormInput {
  accountId: string
  formType: string
  submittedData: Record<string, unknown>
  uploadPaths: string[]
  meta: { token: string; submittedAt: string; companyName?: string; year?: string | number }
  /** the bucket the uploaded files live in (the form type's default when absent) */
  bucket?: string
  /** a form whose files live in MORE than one bucket resolves the bucket per path (wins over `bucket`) */
  resolveBucket?: (path: string) => string
}

export interface SaveAccountFormDeps {
  state: (accountId: string) => Promise<"drive" | "moving" | "store">
  liveOwner: (accountId: string) => Promise<string | null>
  summary: (formType: string, data: Record<string, unknown>, meta: SaveAccountFormInput["meta"] & { uploadCount: number }) => Promise<{ bytes: Buffer | null; error: string | null; subfolder: string; filePrefix: string; defaultBucket: string }>
  store: typeof import("./save-form").saveFormToStore
  /** the old folder of a company with no storage that is still being worked in its folder; null = none */
  oldFolder: (accountId: string) => Promise<string | null>
  toFolder: (i: SaveAccountFormInput, folderId: string) => Promise<FormStoreResult>
  /** an OPEN company with no folder and no storage gets its storage opened (see openStorageForOpenCompany); absent = never */
  openStorage?: (accountId: string) => Promise<boolean>
}

async function defaultDeps(): Promise<SaveAccountFormDeps> {
  const guard = await import("./switched-drive-guard")
  const saveForm = await import("./save-form")
  return {
    state: guard.companyDocState,
    liveOwner: guard.liveOwnerOfAccount,
    store: saveForm.saveFormToStore,
    openStorage: async (accountId) => (await import("./no-storage")).openStorageForOpenCompany(accountId),
    oldFolder: async (accountId) => {
      const { noStorageDecisionFor } = await import("./no-storage")
      const d = await noStorageDecisionFor(accountId)
      return d.route === "drive" ? d.folderId : null
    },
    toFolder: async (i, folderId) => {
      const { saveFormToDrive } = await import("@/lib/form-to-drive")
      return saveFormToDrive(i.formType, i.submittedData, i.uploadPaths, folderId, i.meta, i.bucket || i.resolveBucket ? { bucket: i.bucket, resolveBucket: i.resolveBucket } : undefined)
    },
    summary: async (formType, data, meta) => {
      const f = await import("@/lib/form-to-drive")
      const config = f.FORM_CONFIGS[formType]
      if (!config) throw new Error(`Unknown form type: ${formType}`)
      const prepared = formType === "tax_return" ? f.formatTaxMoneyForPdf(f.normalizeTaxPayloadForPdf(data)) : data
      try {
        const bytes = Buffer.from(await f.generateFormSummaryPDF(config, prepared, { ...meta, deterministic: true }))
        return { bytes, error: null, subfolder: config.driveSubfolder, filePrefix: config.filePrefix, defaultBucket: config.bucket }
      } catch (e) {
        return { bytes: null, error: `Summary PDF error: ${e instanceof Error ? e.message : String(e)}`, subfolder: config.driveSubfolder, filePrefix: config.filePrefix, defaultBucket: config.bucket }
      }
    },
  }
}

export async function saveFormForAccount(input: SaveAccountFormInput, deps?: SaveAccountFormDeps): Promise<SaveAccountFormResult> {
  const d = deps ?? (await defaultDeps())
  let state = await d.state(input.accountId)
  if (state === "moving") {
    const { CompanyMovingError } = await import("./save-for-account")
    throw new CompanyMovingError()
  }
  if (state === "drive" && d.openStorage && (await d.openStorage(input.accountId))) state = await d.state(input.accountId)
  if (state !== "store") {
    const folderId = await d.oldFolder(input.accountId)
    if (!folderId) return { route: "none" }
    return { route: "folder", result: await d.toFolder(input, folderId) }
  }
  const ownerId = await d.liveOwner(input.accountId)
  if (!ownerId) throw new Error("This company's files live in the new storage, but its storage could not be found — nothing was saved.")

  const res = await fileToStore(d, { kind: "account", id: input.accountId, ownerId }, input)
  return { route: "store", result: res }
}

/** File one form's summary + uploads through the store for a company or a person (shared by both entry points). */
async function fileToStore(
  d: Pick<SaveAccountFormDeps, "summary" | "store">,
  target: { kind: "account" | "contact"; id: string; ownerId: string },
  input: Pick<SaveAccountFormInput, "formType" | "submittedData" | "uploadPaths" | "meta" | "bucket" | "resolveBucket">,
): Promise<FormStoreResult> {
  const s = await d.summary(input.formType, input.submittedData, { ...input.meta, uploadCount: input.uploadPaths.length })
  const slug = (input.meta.companyName || input.meta.token).replace(/\s+/g, "_")
  const res = await d.store({
    target,
    subfolder: s.subfolder,
    year: input.formType === "tax_return" ? input.meta.year ?? null : null,
    summary: s.bytes ? {
      name: `${s.filePrefix}_${slug}.pdf`, bytes: s.bytes,
      documentType: input.formType === "formation" ? "formation_summary" : input.formType === "itin" ? "itin_application" : "other_document",
      callerKey: `form-summary:${target.id}:${input.formType}:${input.meta.token}`,
    } : null,
    uploadPaths: input.uploadPaths,
    bucketOf: (path) => (input.resolveBucket ? input.resolveBucket(path) : input.bucket || s.defaultBucket),
    submissionKey: `${target.id}:${input.formType}:${input.meta.token}`,
  })
  return { ...res, errors: [...(s.error ? [s.error] : []), ...res.errors] }
}

export interface SaveContactFormInput extends Omit<SaveAccountFormInput, "accountId"> {
  contactId: string
  contactName?: string | null
}

/**
 * File a form for a PERSON (a closure / form that belongs to a contact, not a company): into the person's own storage, opened
 * for them if they have none (the same as the new-client flow does). Used when a submission has no company.
 */
export async function saveFormForContact(
  input: SaveContactFormInput,
  deps?: Pick<SaveAccountFormDeps, "summary" | "store"> & { personOwner: (contactId: string, name: string) => Promise<string> },
): Promise<SaveAccountFormResult> {
  let d = deps
  if (!d) {
    const base = await defaultDeps()
    d = {
      summary: base.summary,
      store: base.store,
      personOwner: async (contactId, name) => {
        const { liveOwnerOfContact } = await import("./switched-drive-guard")
        const { ensurePersonOwner } = await import("./formation-pilot")
        return (await liveOwnerOfContact(contactId)) ?? (await ensurePersonOwner(contactId, name || "Member"))
      },
    }
  }
  const ownerId = await d.personOwner(input.contactId, input.contactName || "Member")
  const res = await fileToStore(d, { kind: "contact", id: input.contactId, ownerId }, input)
  return { route: "store", result: res }
}

/**
 * Pure: what to tell staff after filing a form, and whether it counts as FILED. Filed = it reached a storage or a folder with no
 * error and no upload that failed. A review tool must not mark a form "reviewed" unless this is true.
 */
export function describeFiling(saved: SaveAccountFormResult | null): { ok: boolean; lines: string[] } {
  if (!saved) return { ok: true, lines: [] }
  if (saved.route === "none") return { ok: false, lines: [`⚠️ ${NO_STORAGE_SENTENCE}`] }
  const r = saved.result
  const lines: string[] = []
  if (r.summaryFileId) lines.push(`✅ Data summary saved (${r.summaryFileId})`)
  if (r.copied.length > 0) lines.push(`✅ ${r.copied.length} file(s) saved`)
  if (r.failed.length > 0) lines.push(`⚠️ ${r.failed.length} file(s) failed to save`)
  if (r.errors.length > 0) lines.push(`⚠️ Errors: ${r.errors.join(", ")}`)
  return { ok: r.errors.length === 0 && r.failed.length === 0, lines }
}

// ─── The closure form: one filing rule for the MCP review tool and the workflow review ───────────────────────────────

export interface ClosureFilingOutcome {
  /** the form may be marked reviewed */
  ok: boolean
  /** plain lines for the staff reply */
  lines: string[]
  /** uploaded files that could not be read (the review is still allowed once the summary is saved): ONE alarm is raised for them */
  missingUploads: string[]
}

export interface ClosureFilingDeps {
  save: (i: SaveAccountFormInput) => Promise<SaveAccountFormResult>
  saveForContact: (i: SaveContactFormInput) => Promise<SaveAccountFormResult>
  finished: (accountId: string) => Promise<boolean>
  alarm: (route: string, token: string, missing: string[]) => Promise<void>
}

async function closureDefaultDeps(): Promise<ClosureFilingDeps> {
  const noStorage = await import("./no-storage")
  return {
    save: (i) => saveFormForAccount(i),
    saveForContact: async (i) => {
      let name = i.contactName ?? null
      if (!name) {
        const { supabaseAdmin } = await import("@/lib/supabase-admin")
        const { data } = await supabaseAdmin.from("contacts").select("full_name").eq("id", i.contactId).maybeSingle()
        name = (data as { full_name?: string | null } | null)?.full_name ?? null
      }
      return saveFormForContact({ ...i, contactName: name })
    },
    finished: noStorage.accountIsFinished,
    alarm: async (route, token, missing) => {
      try {
        const { reportSystemError } = await import("@/lib/system-errors")
        await reportSystemError({ source: "server", route, message: "A closure form upload could not be filed (the file is missing or unreadable) — the form was reviewed without it", context: { token, missing: missing.slice(0, 20) } })
      } catch { /* an alarm never breaks a review */ }
    },
  }
}

/**
 * File a closure submission, deciding whether it may be marked reviewed — the SAME rule for the MCP `closure_form_review` and the
 * workflow review (`lib/operations/closure-review.ts`):
 *   - not linked to a company → NOT filed, not reviewable;
 *   - nothing can receive it but the company is Closed / Cancelled → nothing to file: reviewable, and it says so;
 *   - nothing can receive it (any other company), the company is being moved, or the summary could not be saved → not reviewable;
 *   - the summary is saved but some uploaded file is missing/unreadable → file what exists, ONE alarm, reviewable.
 */
export async function fileClosureSubmission(
  sub: { token: string; account_id: string | null; contact_id?: string | null; contact_name?: string | null; upload_paths: string[] | null; completed_at: string | null },
  submitted: Record<string, unknown>,
  companyName: string,
  route: string,
  deps?: ClosureFilingDeps,
): Promise<ClosureFilingOutcome> {
  const d = deps ?? (await closureDefaultDeps())
  let saved: SaveAccountFormResult
  if (!sub.account_id) {
    // A closure form with no company (a lead or a person who has no company record): a PERSON's package is filed in their own
    // storage; with no person either, there is nothing to file against — the answers stay on the submission itself and the
    // review is still allowed (with a clear note) so the form is never stuck.
    if (!sub.contact_id) {
      return { ok: true, lines: ["ℹ️ This form is not linked to a company or a person, so nothing was filed: the answers stay on the submission itself. The form is marked reviewed."], missingUploads: [] }
    }
    try {
      saved = await d.saveForContact({
        contactId: sub.contact_id,
        contactName: sub.contact_name ?? null,
        formType: "closure",
        submittedData: submitted,
        uploadPaths: sub.upload_paths ?? [],
        meta: { token: sub.token, submittedAt: sub.completed_at || new Date().toISOString(), companyName },
      })
    } catch (e) {
      return { ok: false, lines: [`⚠️ Saving the form data failed: ${e instanceof Error ? e.message : String(e)}`], missingUploads: [] }
    }
    return closureOutcome(saved, sub, route, d)
  }
  try {
    saved = await d.save({
      accountId: sub.account_id,
      formType: "closure",
      submittedData: submitted,
      uploadPaths: sub.upload_paths ?? [],
      meta: { token: sub.token, submittedAt: sub.completed_at || new Date().toISOString(), companyName },
    })
  } catch (e) {
    return { ok: false, lines: [`⚠️ Saving the form data failed: ${e instanceof Error ? e.message : String(e)}`], missingUploads: [] }
  }
  return closureOutcome(saved, sub, route, d)
}

async function closureOutcome(
  saved: SaveAccountFormResult,
  sub: { token: string; account_id: string | null },
  route: string,
  d: ClosureFilingDeps,
): Promise<ClosureFilingOutcome> {
  if (saved.route === "none") {
    let finished = false
    try { finished = await d.finished(sub.account_id as string) } catch { /* unknown → treated as not finished */ }
    if (finished) return { ok: true, lines: ["ℹ️ This company is closed, so there is nothing to file; the form is marked reviewed."], missingUploads: [] }
    return { ok: false, lines: describeFiling(saved).lines, missingUploads: [] }
  }
  const r = saved.result
  const summarySaved = !!r.summaryFileId && r.errors.length === 0
  const missing = r.failed
  if (summarySaved && missing.length > 0) await d.alarm(route, sub.token, missing)
  const lines = describeFiling(saved).lines
  return { ok: summarySaved, lines, missingUploads: summarySaved ? missing : [] }
}
