/**
 * "Where should this be saved?" — the ONE shared rule that PROPOSES a place for a document staff are saving (pure, no database).
 *
 * Antonio 2026-10-20 (dev job c43a8b2e): wherever staff save a document into the CRM storage, a required pop-up proposes a place by
 * the rules, says WHY in plain words, and lets staff change it to anything in storage. This file is the "proposes by the rules" half;
 * the window is `components/storage/save-where-dialog.tsx`, the checks that run before anything is saved are
 * `lib/crm-store/save-destination.ts`. The Fax tool is the first user. The next save point adds its own purposes + rules HERE (one
 * `propose…Place` function per save point), never a second copy elsewhere.
 *
 * Nothing is guessed: no company and no kind of paper is read from a file name. The only thing taken from the name is a tax YEAR, and
 * only when it names exactly one plausible year. Not sure = say so and ask ("choose a place").
 */

/** What a fax is, as staff say it. Never inferred from the file. */
export type FaxPurpose = "irs_tax_return" | "irs_ein_request" | "third_party" | "something_else"

export const FAX_PURPOSES: ReadonlyArray<{ key: FaxPurpose; label: string }> = [
  { key: "irs_tax_return", label: "Tax return to the IRS" },
  { key: "irs_ein_request", label: "EIN request to the IRS" },
  { key: "third_party", label: "For a third party" },
  { key: "something_else", label: "Something else" },
]

export const isFaxPurpose = (v: unknown): v is FaxPurpose => FAX_PURPOSES.some((p) => p.key === v)

/** Who the file is for, as picked in the window: a company (by its CRM id) or the firm's own Business area. */
export type PlaceOwnerRef = { kind: "company"; accountId: string; name: string } | { kind: "business" }

/** A folder as the rule names it. `tax` = the company's Tax folder (inside the year's folder when a year is known); `company` = the
 *  company's own folder; `named` = a folder called `name` directly under the top of the owner's area. */
export type PlaceFolderRef = { kind: "tax"; year: number | null } | { kind: "company" } | { kind: "named"; name: string }

/** The document type kept in the storage (catalog `storage_document_types` slug). */
export type SaveDocumentType = "irs_fax" | "other_document"

export type PlaceProposal =
  | { state: "proposed"; owner: PlaceOwnerRef; folder: PlaceFolderRef; path: string[]; why: string; purpose: FaxPurpose }
  | { state: "choose"; why: string; purpose: FaxPurpose }

/** The folder names the company template gives (verified in the storage templates); the server shows the REAL names it finds. */
export const COMPANY_TAX_FOLDER_LABEL = "3. Tax"
export const COMPANY_OWN_FOLDER_LABEL = "1. Company"
/** The Business folder faxes for third parties go in (made on the spot the first time). */
export const BUSINESS_FAX_FOLDER = "Fax"

/**
 * The single tax year a file name gives — "2025 Tax Return - X.pdf" → 2025. Two different years, none, or an implausible one → null
 * (nothing is guessed: the proposal then says so and uses the Tax folder itself).
 */
export function taxYearFromName(fileName: string, now: Date = new Date()): number | null {
  const years = new Set<number>()
  const re = /(?:^|[^0-9])(20[12][0-9])(?![0-9])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(fileName))) years.add(Number(m[1]))
  const max = now.getFullYear() + 1
  const ok = Array.from(years).filter((y) => y >= 2015 && y <= max)
  return ok.length === 1 ? ok[0] : null
}

/** The document type for an IRS fax; other faxes are a plain "Other document" in a client's storage (the firm's own areas take no type). */
export function documentTypeFor(purpose: FaxPurpose, ownerIsInternalArea: boolean): SaveDocumentType | null {
  if (purpose === "irs_tax_return" || purpose === "irs_ein_request") return "irs_fax"
  return ownerIsInternalArea ? null : "other_document"
}

/**
 * The Fax tool's rule (Antonio): a tax-return fax to the IRS → that company's Tax folder, in the tax year's folder; an EIN-request fax
 * to the IRS → the company's own folder; a fax for a third party → Business › Fax; anything else → nothing is proposed.
 */
export function proposeFaxPlace(i: { purpose: FaxPurpose; company: PlaceOwnerRef | null; fileName: string; now?: Date }): PlaceProposal {
  const { purpose } = i
  const company = i.company && i.company.kind === "company" ? i.company : null
  const chosenBusiness = !!i.company && i.company.kind === "business"
  if (purpose === "irs_tax_return") {
    if (!company) {
      return { state: "choose", purpose, why: chosenBusiness
        ? "A tax return belongs to a company, so it has no place in Business. Pick the company above, or use Change place (for example Business › Fax)."
        : "A tax-return fax is saved in a company's Tax folder, so pick the company above. Or use Change place." }
    }
    const year = taxYearFromName(i.fileName, i.now)
    return {
      state: "proposed", purpose,
      owner: company, folder: { kind: "tax", year },
      path: year ? [company.name, COMPANY_TAX_FOLDER_LABEL, String(year)] : [company.name, COMPANY_TAX_FOLDER_LABEL],
      why: year
        ? `A tax-return fax to the IRS goes in the company's Tax folder, in that tax year's folder. The year (${year}) comes from the file name.`
        : "A tax-return fax to the IRS goes in the company's Tax folder. The file name does not give one single tax year, so it goes in the Tax folder itself. Use Change place to pick a year.",
    }
  }
  if (purpose === "irs_ein_request") {
    if (!company) {
      return { state: "choose", purpose, why: chosenBusiness
        ? "An EIN request belongs to a company, so it has no place in Business. Pick the company above, or use Change place (for example Business › Fax)."
        : "An EIN request is saved in the company's own folder, so pick the company above. Or use Change place." }
    }
    return {
      state: "proposed", purpose,
      owner: company, folder: { kind: "company" },
      path: [company.name, COMPANY_OWN_FOLDER_LABEL],
      why: "An EIN-request fax to the IRS goes in the company's own folder (Company).",
    }
  }
  if (purpose === "third_party") {
    return {
      state: "proposed", purpose,
      owner: { kind: "business" }, folder: { kind: "named", name: BUSINESS_FAX_FOLDER },
      path: ["Business", BUSINESS_FAX_FOLDER],
      why: "A fax for a third party who is not a client goes in Business, in the Fax folder.",
    }
  }
  return { state: "choose", purpose, why: "No rule matches this fax, so nothing is guessed. Choose a place." }
}
