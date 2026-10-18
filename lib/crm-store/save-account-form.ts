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
}

export interface SaveAccountFormDeps {
  state: (accountId: string) => Promise<"drive" | "moving" | "store">
  liveOwner: (accountId: string) => Promise<string | null>
  summary: (formType: string, data: Record<string, unknown>, meta: SaveAccountFormInput["meta"] & { uploadCount: number }) => Promise<{ bytes: Buffer | null; error: string | null; subfolder: string; filePrefix: string; defaultBucket: string }>
  store: typeof import("./save-form").saveFormToStore
  /** the old folder of a company with no storage that is still being worked in its folder; null = none */
  oldFolder: (accountId: string) => Promise<string | null>
  toFolder: (i: SaveAccountFormInput, folderId: string) => Promise<FormStoreResult>
}

async function defaultDeps(): Promise<SaveAccountFormDeps> {
  const guard = await import("./switched-drive-guard")
  const saveForm = await import("./save-form")
  return {
    state: guard.companyDocState,
    liveOwner: guard.liveOwnerOfAccount,
    store: saveForm.saveFormToStore,
    oldFolder: async (accountId) => {
      const { noStorageDecisionFor } = await import("./no-storage")
      const d = await noStorageDecisionFor(accountId)
      return d.route === "drive" ? d.folderId : null
    },
    toFolder: async (i, folderId) => {
      const { saveFormToDrive } = await import("@/lib/form-to-drive")
      return saveFormToDrive(i.formType, i.submittedData, i.uploadPaths, folderId, i.meta, i.bucket ? { bucket: i.bucket } : undefined)
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
  const state = await d.state(input.accountId)
  if (state === "moving") {
    const { CompanyMovingError } = await import("./save-for-account")
    throw new CompanyMovingError()
  }
  if (state !== "store") {
    const folderId = await d.oldFolder(input.accountId)
    if (!folderId) return { route: "none" }
    return { route: "folder", result: await d.toFolder(input, folderId) }
  }
  const ownerId = await d.liveOwner(input.accountId)
  if (!ownerId) throw new Error("This company's files live in the new storage, but its storage could not be found — nothing was saved.")

  const s = await d.summary(input.formType, input.submittedData, { ...input.meta, uploadCount: input.uploadPaths.length })
  const slug = (input.meta.companyName || input.meta.token).replace(/\s+/g, "_")
  const res = await d.store({
    target: { kind: "account", id: input.accountId, ownerId },
    subfolder: s.subfolder,
    year: input.formType === "tax_return" ? input.meta.year ?? null : null,
    summary: s.bytes ? {
      name: `${s.filePrefix}_${slug}.pdf`, bytes: s.bytes,
      documentType: input.formType === "formation" ? "formation_summary" : input.formType === "itin" ? "itin_application" : "other_document",
      callerKey: `form-summary:${input.accountId}:${input.formType}:${input.meta.token}`,
    } : null,
    uploadPaths: input.uploadPaths,
    bucketOf: () => input.bucket || s.defaultBucket,
    submissionKey: `${input.accountId}:${input.formType}:${input.meta.token}`,
  })
  return { route: "store", result: { ...res, errors: [...(s.error ? [s.error] : []), ...res.errors] } }
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
