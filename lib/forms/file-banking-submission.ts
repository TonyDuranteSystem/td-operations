/**
 * Banking — file ONE stored banking submission, from the ROW (Stop Drive S1d, dev job 264bb882).
 *
 * Every lane that files a banking package (the portal wizard, the public banking form, the staff review tool, "Approve & Apply",
 * the durable archive job) builds its input here, from the stored row, so they all agree on the same:
 *   - which summary (one key per submission: the wizard's own config for a wizard row, the public form's for a public-form row),
 *   - which uploads (the column plus the paths inside the submitted data),
 *   - which PERSON the personal papers belong to (never "the first linked contact" of a company with several members).
 */
import { fileBankingPackage, type BankingPackageInput, type BankingPackageResult } from "@/lib/forms/file-banking-package"

export type BankingOrigin = "wizard" | "external"

export interface BankingRow {
  id: string
  token: string | null
  provider: string | null
  account_id: string | null
  contact_id: string | null
  submitted_data: Record<string, unknown> | null
  upload_paths?: unknown
  completed_at: string | null
  created_at?: string | null
  drive_archived_at?: string | null
  drive_archive_meta?: Record<string, unknown> | null
}

export const BANKING_ROW_COLUMNS = "id, token, provider, account_id, contact_id, submitted_data, upload_paths, completed_at, created_at, drive_archived_at, drive_archive_meta"

/**
 * Which form produced the row. Written into the row's archive meta when it is submitted; for older rows: the public form stores its
 * uploads in the `upload_paths` column, the wizard only inside the answers.
 */
export function bankingOriginOf(row: Pick<BankingRow, "upload_paths" | "drive_archive_meta">): BankingOrigin {
  const o = (row.drive_archive_meta ?? {})["origin"]
  if (o === "wizard" || o === "external") return o
  return Array.isArray(row.upload_paths) && row.upload_paths.length > 0 ? "external" : "wizard"
}

export interface ApplicantDeps {
  /** how many different people are linked to the company */
  linkedContacts: (accountId: string) => Promise<string[]>
}

async function defaultApplicantDeps(): Promise<ApplicantDeps> {
  return {
    linkedContacts: async (accountId) => {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      const { data, error } = await supabaseAdmin.from("account_contacts").select("contact_id").eq("account_id", accountId)
      if (error) throw new Error("Could not read the company's people — please try again.")
      return Array.from(new Set(((data ?? []) as Array<{ contact_id: string | null }>).map((r) => r.contact_id).filter((x): x is string => !!x)))
    },
  }
}

/**
 * The person whose personal papers these are — or null when that is not certain (the papers are then held and staff told once).
 *  - the row records the member who SUBMITTED it (wizard)             -> that member
 *  - a public-form row: the form is opened with the e-mail of the row's contact -> the row's contact
 *  - otherwise the row's contact, only when the company has exactly ONE person (no choice to get wrong)
 * A thrown read error is NOT "nobody": it propagates so the caller retries.
 */
export async function resolveBankingApplicant(row: Pick<BankingRow, "account_id" | "contact_id" | "upload_paths" | "drive_archive_meta">, deps?: ApplicantDeps): Promise<string | null> {
  if (!row.contact_id) return null
  const meta = row.drive_archive_meta ?? {}
  if (meta["applicant"] === "submitter") return row.contact_id
  if (bankingOriginOf(row) === "external") return row.contact_id
  if (!row.account_id) return null
  const d = deps ?? (await defaultApplicantDeps())
  const people = await d.linkedContacts(row.account_id)
  return people.length === 1 && people[0] === row.contact_id ? row.contact_id : null
}

export async function buildBankingInput(row: BankingRow, flow: string, extra?: { companyName?: string | null; applicantDeps?: ApplicantDeps }): Promise<BankingPackageInput> {
  const { bankingConfigAndBucket, deriveUploadPaths } = await import("@/lib/forms/archive-registry")
  const origin = bankingOriginOf(row)
  const { configKey, bucket } = origin === "wizard" ? bankingConfigAndBucket(row.provider) : { configKey: "banking", bucket: "banking-uploads" }
  let companyName = extra?.companyName ?? undefined
  if (companyName === undefined && row.account_id) {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    const { data, error } = await supabaseAdmin.from("accounts").select("company_name").eq("id", row.account_id).maybeSingle()
    if (error) throw new Error(`Could not read the company: ${error.message}`)
    companyName = (data?.company_name as string | null | undefined) ?? undefined
  }
  const contactId = await resolveBankingApplicant(row, extra?.applicantDeps)
  return {
    flow, formType: configKey, accountId: row.account_id, contactId,
    submittedData: (row.submitted_data ?? {}) as Record<string, unknown>,
    uploadPaths: deriveUploadPaths(row.upload_paths, row.submitted_data),
    bucket, token: row.token ?? configKey, submittedAt: row.completed_at ?? row.created_at ?? null, companyName: companyName || row.token || undefined,
  }
}

export interface FileBankingSubmissionResult {
  pkg: BankingPackageResult
  markedFiled: boolean
  /** a durable retry job was queued because the package is not fully filed */
  queued: boolean
  enqueueError: string | null
}

/**
 * Load the row, file its package, and either record "filed" (only when EVERYTHING was filed) or queue the durable retry job.
 * A failed filing clears an older "filed" mark first, so a resubmitted application is retried like any other.
 */
export async function fileBankingSubmission(submissionId: string, flow: string, opts?: { row?: BankingRow; companyName?: string | null }): Promise<FileBankingSubmissionResult> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  let row = opts?.row
  if (!row) {
    const { data, error } = await supabaseAdmin.from("banking_submissions").select(BANKING_ROW_COLUMNS).eq("id", submissionId).maybeSingle()
    if (error) throw new Error(`Could not read the banking submission: ${error.message}`)
    if (!data) throw new Error("Banking submission not found.")
    row = data as unknown as BankingRow
  }
  if (!row.submitted_data) throw new Error("This banking submission has no answers saved — there is nothing to file.")
  const pkg = await fileBankingPackage(await buildBankingInput(row, flow, { companyName: opts?.companyName }))
  let markedFiled = false
  if (pkg.ok) {
    const { markBankingSubmissionFiled } = await import("@/lib/forms/mark-banking-filed")
    markedFiled = await markBankingSubmissionFiled(submissionId, { flow, summaryFileId: pkg.summaryFileId, copied: pkg.copied, folderId: pkg.pinFolderId })
  }
  let queued = false
  let enqueueError: string | null = null
  if (!markedFiled && (pkg.pinFolderId || pkg.enqueueUnpinned)) {
    try {
      if (row.drive_archived_at) await supabaseAdmin.from("banking_submissions").update({ drive_archived_at: null } as never).eq("id", submissionId)
      const { enqueueFormArchiveJob } = await import("@/lib/forms/archive-enqueue")
      const r = await enqueueFormArchiveJob({ formType: "banking", submissionId, createdBy: flow })
      queued = r.status === "enqueued" || r.status === "already_queued"
    } catch (e) {
      enqueueError = e instanceof Error ? e.message : String(e)
    }
  }
  return { pkg, markedFiled, queued, enqueueError }
}
