/**
 * Banking — file ONE banking application package (summary PDF + the client's uploads) (Stop Drive S1d, dev job 264bb882).
 *
 * One function for every banking lane (portal wizard, the public banking form, the staff review tool, the durable archive job), so
 * they all decide the same way:
 *   - WHERE: a company in storage -> its storage ("account-storage:<id>"); a company left on Drive -> its Drive folder; otherwise
 *     nothing is filed and the caller gets a plain sentence (and, when the company is merely moving, a "try again later").
 *   - WHAT goes WHERE (privacy): the client's PERSONAL papers (passport, ID, proof of address …) go to the PERSON's own storage —
 *     never into the company's folder, where whoever the company is handed to later could see them. The summary PDF and the
 *     business papers go to the company. A company left on Drive keeps everything in its Drive folder, as before.
 *   - If a personal paper has no person to be filed under, it is NOT filed (it stays where the client uploaded it) and ONE alarm
 *     is raised.
 *   - Stable: the same submission always uses the same key, and the PDF carries the day (not the minute), so a replay or a retry
 *     files the same files (unchanged) instead of piling up versions.
 */

export interface BankingPackageInput {
  flow: string
  /** saveFormToDrive form-config key: banking | banking_payset | banking_relay */
  formType: string
  accountId: string | null
  /** the person who submitted (the owner / member who uploaded the personal papers) */
  contactId: string | null
  submittedData: Record<string, unknown>
  uploadPaths: string[]
  bucket: string
  /** one stable key per submission (the banking submission's token) */
  token: string
  /** when it was submitted (the row's completed_at); only the DAY is used, so a retry makes the same PDF */
  submittedAt?: string | null
  /** an already-decided destination (the durable job's pinned plan): skips the lookup */
  folderId?: string | null
  companyName?: string
}

export interface BankingPackageResult {
  /** everything that had to be filed was filed */
  ok: boolean
  /** a retry later can succeed (the company is being moved) */
  retryLater: boolean
  /** where the durable job should file it (null = nowhere) */
  pinFolderId: string | null
  summaryFileId: string | null
  copied: string[]
  failed: string[]
  errors: string[]
  sentence: string | null
}

const PERSONAL_NAME = /^(passport|id[_-]|identity|national[_-]?id|driver|licen[cs]e|proof[_-]?of[_-]?address|utility|residence|ssn|selfie)/i

/** A client's personal paper, by the wizard field name at the start of the stored file name ({field}_{unique}_{filename}). */
export function isPersonalUpload(path: string): boolean {
  const name = path.split("/").pop() || ""
  return PERSONAL_NAME.test(name)
}

/** A wizard upload lives in the shared wizard bucket, an external-form upload in the banking bucket: decided per file. */
export function bucketForUpload(path: string, fallback: string): string {
  return /^banking_(payset|relay)\//.test(path) ? "onboarding-uploads" : fallback
}

export function splitUploads(paths: string[]): { personal: string[]; business: string[] } {
  const personal: string[] = [], business: string[] = []
  for (const p of paths) (isPersonalUpload(p) ? personal : business).push(p)
  return { personal, business }
}

/** The day, not the minute: a replay on the same day produces the very same PDF. */
export function stableSubmittedAt(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
}

export interface BankingPackageDeps {
  destination: (accountId: string | null | undefined, flow: string) => Promise<
    { ok: true; folderId: string; via: "storage" | "legacy-drive" } | { ok: false; reason: string; sentence: string }>
  saveCompany: (i: { formType: string; data: Record<string, unknown>; paths: string[]; folderId: string; token: string; submittedAt: string; companyName?: string; bucket: string }) =>
    Promise<{ summaryFileId: string | null; copied: string[]; failed: string[]; errors: string[] }>
  savePerson: (i: { contactId: string; formType: string; paths: string[]; token: string; bucket: string; name: string }) =>
    Promise<{ copied: string[]; failed: string[]; errors: string[] }>
  alarm: (message: string, context: Record<string, unknown>) => Promise<void>
  now: () => Date
}

async function defaultDeps(): Promise<BankingPackageDeps> {
  return {
    destination: async (accountId, flow) => (await import("@/lib/crm-store/form-destination")).formDestinationForAccount(accountId, flow) as never,
    saveCompany: async (i) => {
      const { saveFormToDrive } = await import("@/lib/form-to-drive")
      return saveFormToDrive(i.formType, i.data, i.paths, i.folderId, { token: i.token, submittedAt: i.submittedAt, companyName: i.companyName }, { bucket: i.bucket, resolveBucket: (path) => bucketForUpload(path, i.bucket) })
    },
    savePerson: async (i) => {
      const { liveOwnerOfContact } = await import("@/lib/crm-store/switched-drive-guard")
      const { ensurePersonOwner } = await import("@/lib/crm-store/formation-pilot")
      const ownerId = (await liveOwnerOfContact(i.contactId)) ?? (await ensurePersonOwner(i.contactId, i.name || "Member"))
      const { saveFormToStore } = await import("@/lib/crm-store/save-form")
      const r = await saveFormToStore({
        target: { kind: "contact", id: i.contactId, ownerId }, subfolder: "2. Contacts", year: null, summary: null,
        uploadPaths: i.paths, bucketOf: (path) => bucketForUpload(path, i.bucket), submissionKey: `${i.contactId}:${i.formType}:${i.token}`,
      })
      return { copied: [...r.copied, ...r.skipped], failed: r.failed, errors: r.errors }
    },
    alarm: async (message, context) => {
      const { reportSystemError } = await import("@/lib/system-errors")
      await reportSystemError({ source: "server", route: "forms/file-banking-package", method: "INTERNAL", message, context })
    },
    now: () => new Date(),
  }
}

export async function fileBankingPackage(p: BankingPackageInput, deps?: BankingPackageDeps): Promise<BankingPackageResult> {
  const d = deps ?? (await defaultDeps())
  const out: BankingPackageResult = { ok: false, retryLater: false, pinFolderId: null, summaryFileId: null, copied: [], failed: [], errors: [], sentence: null }
  const dest = p.folderId
    ? ({ ok: true, folderId: p.folderId, via: /^(account|person)-storage:/.test(p.folderId) ? "storage" : "legacy-drive" } as const)
    : await d.destination(p.accountId, p.flow)
  if (!dest.ok) {
    out.sentence = dest.sentence
    out.retryLater = dest.reason === "moving"
    // a company that is only moving is retried by the durable job once it has a storage again
    if (out.retryLater && p.accountId) out.pinFolderId = `account-storage:${p.accountId}`
    out.errors.push(dest.sentence)
    return out
  }
  out.pinFolderId = dest.folderId
  const split = dest.via === "storage" ? splitUploads(p.uploadPaths) : { personal: [] as string[], business: p.uploadPaths }
  const when = p.submittedAt && !Number.isNaN(Date.parse(p.submittedAt)) ? new Date(p.submittedAt) : d.now()
  const submittedAt = stableSubmittedAt(when)
  const company = await d.saveCompany({ formType: p.formType, data: p.submittedData, paths: split.business, folderId: dest.folderId, token: p.token, submittedAt, companyName: p.companyName, bucket: p.bucket })
  out.summaryFileId = company.summaryFileId
  out.copied.push(...company.copied)
  out.failed.push(...company.failed)
  out.errors.push(...company.errors)
  if (split.personal.length > 0) {
    if (!p.contactId) {
      // nobody to file the personal papers under: they stay where the client uploaded them, and staff are told ONCE
      out.failed.push(...split.personal.map((x) => `${x.split("/").pop()} (no person to file it under — left where it was uploaded)`))
      out.errors.push("The client's personal papers were not filed: no person is linked to this submission.")
      await d.alarm("Banking package: personal papers could not be filed (no person linked)", { flow: p.flow, accountId: p.accountId, token: p.token, files: split.personal.length })
    } else {
      try {
        const r = await d.savePerson({ contactId: p.contactId, formType: p.formType, paths: split.personal, token: p.token, bucket: p.bucket, name: p.companyName ?? "" })
        out.copied.push(...r.copied)
        out.failed.push(...r.failed)
        out.errors.push(...r.errors)
      } catch (e) {
        out.failed.push(...split.personal.map((x) => x.split("/").pop() || x))
        out.errors.push(`Personal papers: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  out.ok = out.errors.length === 0 && out.failed.length === 0
  return out
}
