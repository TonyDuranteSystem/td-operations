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
 *   - Stable: the same submission always uses the same key, and the PDF carries the day (not the minute) and is made without a
 *     creation/modification stamp, so a replay or a retry files the same bytes (recorded "unchanged") instead of piling up versions.
 *   - FAIL CLOSED: only a paper on the short allow-list of BUSINESS documents goes to the company; every other paper (a new field,
 *     an unknown name) is treated as personal. A person with only a hidden study-copy storage gets nothing filed and ONE alarm.
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
  /** a destination decided earlier: honoured ONLY when it is this company's storage marker (a move in progress); anything else is looked up again now */
  folderId?: string | null
  companyName?: string
  /** the person's own name, used only when the CRM contact's name cannot be read (the folder is named from the CRM contact) */
  personName?: string | null
}

export interface BankingPackageResult {
  /** everything that had to be filed was filed */
  ok: boolean
  /** a retry later can succeed (the company is being moved) */
  retryLater: boolean
  /** where the durable job should file it (null = nowhere known) */
  pinFolderId: string | null
  /** the destination could not be worked out right now (a read failed): queue the durable job WITHOUT a pin so its own lookup retries */
  enqueueUnpinned: boolean
  summaryFileId: string | null
  copied: string[]
  failed: string[]
  errors: string[]
  sentence: string | null
  /** personal papers that were deliberately NOT filed (no certain person / hidden study copy) */
  heldPersonal: string[]
}

/** The only papers that belong to the COMPANY (allow-list). Anything else is personal or unknown and never goes to the company. */
const BUSINESS_NAME = /^(business[_-]|articles|ein[_-]|ss-?4|operating[_-]?agreement|certificate|company[_-]|llc[_-])/i

/** A business paper, by the wizard field name at the start of the stored file name ({field}_{unique}_{filename}). */
export function isBusinessUpload(path: string): boolean {
  const name = path.split("/").pop() || ""
  return BUSINESS_NAME.test(name)
}

/** Everything that is not a known business paper is treated as the client's personal paper (fail closed). */
export function isPersonalUpload(path: string): boolean {
  return !isBusinessUpload(path)
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
    { ok: boolean; folderId?: string; via?: "storage" | "legacy-drive"; reason?: string; sentence?: string }>
  saveCompany: (i: { formType: string; data: Record<string, unknown>; paths: string[]; folderId: string; token: string; submittedAt: string; companyName?: string; bucket: string }) =>
    Promise<{ summaryFileId: string | null; copied: string[]; failed: string[]; errors: string[] }>
  savePerson: (i: { contactId: string; formType: string; paths: string[]; token: string; bucket: string; name: string }) =>
    Promise<{ copied: string[]; failed: string[]; errors: string[]; blocked?: "no_contact" | "study_only_owner" }>
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
      // the SAME destination rule as every lead-stage form (lead-form-store): the person's live storage (opened on first use, root named
      // from the CRM contact's own name); a person who only has a hidden study copy gets NOTHING filed
      const { storageDestinationForForm } = await import("@/lib/crm-store/lead-form-store")
      const dest = await storageDestinationForForm({ contactId: i.contactId, personName: i.name || null })
      if (!dest.marker) return { copied: [], failed: [], errors: [], blocked: dest.reason }
      const { liveOwnerOfContact } = await import("@/lib/crm-store/switched-drive-guard")
      const ownerId = await liveOwnerOfContact(i.contactId)
      if (!ownerId) throw new Error("This person's storage could not be found — nothing was filed.")
      const { saveFormToStore } = await import("@/lib/crm-store/save-form")
      const r = await saveFormToStore({
        target: { kind: "contact", id: i.contactId, ownerId }, subfolder: "2. Contacts", year: null, summary: null,
        uploadPaths: i.paths, bucketOf: (path) => bucketForUpload(path, i.bucket), submissionKey: `${i.contactId}:${i.formType}:${i.token}`,
      })
      return { copied: [...r.copied, ...r.skipped], failed: r.failed, errors: r.errors }
    },
    // ONE alarm per identical problem per hour (a retrying job or a sweep must not repeat it)
    alarm: async (message, context) => {
      const { raiseThrottledAlarm } = await import("@/lib/crm-store/throttled-alarm")
      await raiseThrottledAlarm("banking_package_problem", { message, ...context })
    },
    now: () => new Date(),
  }
}

export async function fileBankingPackage(p: BankingPackageInput, deps?: BankingPackageDeps): Promise<BankingPackageResult> {
  const d = deps ?? (await defaultDeps())
  const out: BankingPackageResult = { ok: false, retryLater: false, pinFolderId: null, enqueueUnpinned: false, summaryFileId: null, copied: [], failed: [], errors: [], sentence: null, heldPersonal: [] }
  let dest: { ok: boolean; folderId?: string; via?: "storage" | "legacy-drive"; reason?: string; sentence?: string }
  try {
    // a pinned destination counts only when it is THIS company's storage marker; a Drive folder id (a plan pinned before the move to
    // storage, or for a company that has moved since) is ignored and the destination is worked out again now
    dest = p.folderId && p.accountId && p.folderId === `account-storage:${p.accountId}`
      ? { ok: true, folderId: p.folderId, via: "storage" }
      : await d.destination(p.accountId, p.flow)
  } catch (e) {
    // a failed lookup is NOT "no folder": say so, and let the durable job look again later
    out.retryLater = true
    out.enqueueUnpinned = !!p.accountId
    out.errors.push(`Could not work out where to file this: ${e instanceof Error ? e.message : String(e)}`)
    await d.alarm("Banking package: destination lookup failed", { flow: p.flow, accountId: p.accountId, token: p.token })
    return out
  }
  if (!dest.ok) {
    out.sentence = dest.sentence ?? null
    out.retryLater = dest.reason === "moving"
    // a company that is only moving is retried by the durable job once it has a storage again
    if (out.retryLater && p.accountId) out.pinFolderId = `account-storage:${p.accountId}`
    out.errors.push(dest.sentence ?? "Nothing could be filed.")
    return out
  }
  out.pinFolderId = dest.folderId ?? null
  const split = dest.via === "storage" ? splitUploads(p.uploadPaths) : { personal: [] as string[], business: p.uploadPaths }
  const when = p.submittedAt && !Number.isNaN(Date.parse(p.submittedAt)) ? new Date(p.submittedAt) : d.now()
  const submittedAt = stableSubmittedAt(when)
  const company = await d.saveCompany({ formType: p.formType, data: p.submittedData, paths: split.business, folderId: dest.folderId as string, token: p.token, submittedAt, companyName: p.companyName, bucket: p.bucket })
  out.summaryFileId = company.summaryFileId
  out.copied.push(...company.copied)
  out.failed.push(...company.failed)
  out.errors.push(...company.errors)
  if (split.personal.length > 0) {
    const hold = async (why: string, detail: string) => {
      out.heldPersonal.push(...split.personal)
      out.failed.push(...split.personal.map((x) => `${x.split("/").pop()} (${detail} — left where it was uploaded)`))
      out.errors.push(`The client's personal papers were not filed: ${detail}.`)
      await d.alarm(`Banking package: personal papers could not be filed (${why})`, { flow: p.flow, accountId: p.accountId, contactId: p.contactId, token: p.token, files: split.personal.length })
    }
    if (!p.contactId) {
      // nobody certain to file the personal papers under: they stay where the client uploaded them, and staff are told ONCE
      await hold("no person linked", "no person is linked to this submission")
    } else {
      try {
        const r = await d.savePerson({ contactId: p.contactId, formType: p.formType, paths: split.personal, token: p.token, bucket: p.bucket, name: p.personName ?? "" })
        if (r.blocked) {
          await hold(r.blocked, r.blocked === "study_only_owner" ? "this person only has a hidden study copy of their storage" : "no person is linked to this submission")
        } else {
          out.copied.push(...r.copied)
          out.failed.push(...r.failed)
          out.errors.push(...r.errors)
        }
      } catch (e) {
        out.failed.push(...split.personal.map((x) => x.split("/").pop() || x))
        out.errors.push(`Personal papers: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  out.ok = out.errors.length === 0 && out.failed.length === 0
  return out
}
