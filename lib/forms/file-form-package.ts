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
  formType: "formation" | "onboarding" | "closure" | "itin"
  submittedData: Record<string, unknown>
  uploadPaths: string[]
  meta: { token: string; submittedAt: string; companyName?: string }
  bucket?: string
  resolveBucket?: (path: string) => string
  /** closure only: a company that still has its own Drive folder keeps filing there (the storage gate inside saveFormToDrive redirects a switched one) */
  driveFolderId?: string | null
  /** onboarding creates no contact before staff review: "no contact" is then expected, not an alarm */
  noContactIsExpected?: boolean
  /** the name each stored upload gets (see memberAwareFileName) */
  fileNameOf?: (path: string) => string
  /** stop waiting after this long (default 20 s): the route's own steps (email, task, delivery) must never be starved — the retry job finishes the filing */
  deadlineMs?: number
}

/**
 * MMLLC: a member's passport is stored as passport_member_<N>_<First_Last>.<ext> (the owner's as passport_owner_<name>…) so staff can
 * tell whose is whose in the primary contact's Personal documents. Every other upload keeps its own name.
 */
export function memberAwareFileName(submittedData: Record<string, unknown>): (path: string) => string {
  const clean = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  const members = Array.isArray(submittedData.additional_members) ? (submittedData.additional_members as Array<Record<string, unknown>>) : []
  return (path: string) => {
    const base = path.split("/").pop() || "document.pdf"
    const dot = base.lastIndexOf(".")
    const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : ""
    const m = /passport_member_(\d+)/.exec(stem)
    if (m) {
      const mem = members[Number(m[1])]
      const who = mem ? clean(mem.member_type === "company" ? mem.member_company_name : `${mem.member_first_name ?? ""} ${mem.member_last_name ?? ""}`) : ""
      return who ? `passport_member_${m[1]}_${who}${ext}` : base
    }
    if (/passport_owner/.test(stem)) {
      const who = clean(`${submittedData.owner_first_name ?? ""} ${submittedData.owner_last_name ?? ""}`)
      return who ? `passport_owner_${who}${ext}` : base
    }
    return base
  }
}

async function fileFormPackageNow(i: FileFormPackageInput): Promise<FilingStep> {
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
    const res = await saveFormToDrive(i.formType, i.submittedData, i.uploadPaths, folder, i.meta, { bucket: i.bucket, resolveBucket: i.resolveBucket, fileNameOf: i.fileNameOf })
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

export async function fileFormPackage(i: FileFormPackageInput): Promise<FilingStep> {
  const ms = i.deadlineMs ?? 20_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms) })
  try {
    const first = await Promise.race([fileFormPackageNow(i), timedOut])
    if (first !== "timeout") return first
  } finally {
    if (timer) clearTimeout(timer)
  }
  const detail = `Filing was still running after ${Math.round(ms / 1000)} s — the rest of the steps carried on; the retry job finishes it`
  await raisePilotAlarm("lead_form_filing_failed", { route: i.route, formType: i.formType, token: i.meta.token, contactId: i.contactId ?? null, accountId: i.accountId ?? null, problems: [detail] })
  return { step: "storage_save", status: "error", detail }
}
