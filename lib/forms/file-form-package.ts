/**
 * File one lead-stage form package (summary PDF + uploads) in the client's storage and report it honestly
 * (Stop-Drive S1a fix round). Used by the formation / onboarding / closure completion routes.
 *
 * A step is "ok" ONLY when the summary was saved and no file failed and no error was reported. Anything else is an
 * "error" step AND a staff-visible alarm (the store's alarm path: store_events + system_errors) — a failed filing is never silent.
 */

import { saveFormToDrive } from "@/lib/form-to-drive"
import { storageDestinationForForm, type FormStorageInput } from "@/lib/crm-store/lead-form-store"
import { raisePilotAlarm } from "@/lib/crm-store/formation-pilot"

export interface FilingStep { step: "storage_save"; status: "ok" | "error" | "skipped"; detail: string }

export interface FileFormPackageInput extends FormStorageInput {
  route: string
  formType: "formation" | "onboarding" | "closure"
  submittedData: Record<string, unknown>
  uploadPaths: string[]
  meta: { token: string; submittedAt: string; companyName?: string }
  bucket?: string
  resolveBucket?: (path: string) => string
  /** closure only: a company that still has its own Drive folder keeps filing there (the storage gate inside saveFormToDrive redirects a switched one) */
  driveFolderId?: string | null
  /** onboarding creates no contact before staff review: "no contact" is then expected, not an alarm */
  noContactIsExpected?: boolean
}

export async function fileFormPackage(i: FileFormPackageInput): Promise<FilingStep> {
  const context = { route: i.route, formType: i.formType, token: i.meta.token, contactId: i.contactId ?? null, accountId: i.accountId ?? null }
  try {
    let folder = i.driveFolderId ?? null
    if (!folder) {
      const dest = await storageDestinationForForm(i)
      if (!dest.marker) {
        if (dest.reason === "no_contact") {
          if (i.noContactIsExpected) return { step: "storage_save", status: "skipped", detail: "No contact record yet — the uploads stay with the submission until staff review" }
          const detail = "No company storage and no contact record to file this under — the uploads stay with the submission"
          await raisePilotAlarm("lead_form_filing_failed", { ...context, problems: [detail] })
          return { step: "storage_save", status: "error", detail }
        }
        const detail = dest.reason === "study_only_owner"
          ? "This person still lives on Drive (only a hidden study copy exists) — nothing was filed; the uploads stay with the submission"
          : "This person still lives on Drive — no storage was opened and nothing was filed; the uploads stay with the submission"
        await raisePilotAlarm("lead_form_person_on_drive", { ...context, reason: dest.reason })
        return { step: "storage_save", status: "error", detail }
      }
      folder = dest.marker
    }
    const res = await saveFormToDrive(i.formType, i.submittedData, i.uploadPaths, folder, i.meta, { bucket: i.bucket, resolveBucket: i.resolveBucket })
    const problems = [
      res.summaryFileId ? null : "the summary PDF was not saved",
      res.failed.length ? `${res.failed.length} file(s) failed: ${res.failed.join("; ")}` : null,
      res.errors.length ? `errors: ${res.errors.join("; ")}` : null,
    ].filter((x): x is string => !!x)
    if (problems.length > 0) {
      await raisePilotAlarm("lead_form_filing_failed", { ...context, problems })
      return { step: "storage_save", status: "error", detail: problems.join(" | ") }
    }
    return { step: "storage_save", status: "ok", detail: `Summary saved. ${res.copied.length} file(s) filed${res.skipped.length ? `, ${res.skipped.length} already there` : ""}.` }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    await raisePilotAlarm("lead_form_filing_failed", { ...context, problems: [detail] })
    return { step: "storage_save", status: "error", detail }
  }
}
