/**
 * Fax — personal papers (the protection that outlived the old auto-filing).
 *
 * Until 2026-10-20 this file also decided WHERE a faxed upload was copied by reading the company and the year out of the file name
 * (dev job 264bb882, S1d). That guessing is gone: staff now choose in the "Where should this fax be saved?" window
 * (`components/storage/save-where-dialog.tsx`, rules in `lib/crm-store/save-where.ts`, checks in `lib/crm-store/save-destination.ts`).
 * What stays is the protection for a PERSON's own paper:
 *   - an identity / residence paper (passport, ID, visa, I-94, birth certificate, SSN, W-7/ITIN, proof of address …) is never saved
 *     in a company's or a person's storage from the Fax tool, and never gets an internal copy anyone on the staff could open;
 *   - an SS-4 or a 1040-family return is saved where staff chose, but is NEVER listed on a company's Documents tab.
 *
 * The name is NORMALIZED first (QA 2026-10-20): "_", ".", "-", "(", ")" and every other non-letter/digit are separators, camelCase and
 * letter↔digit boundaries are split ("SS4Form" → "ss 4 form", "Form_1040_2024" → "form 1040 2024", "W-7_Rossi" → "w 7 rossi"). A plain
 * `\b…\b` does not work: "_" and digits are word characters, so "SS-4_Acme_Signed_for_IRS.pdf" was NOT recognised. 116 production fax
 * files are named like "…Signed_for_IRS".
 */

/** Pure: the file name as lowercase words separated by single spaces (also splits camelCase and letter↔digit). */
export function normalizeFaxName(fileName: string): string {
  return fileName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
}

/** Identity and residence papers: they belong to ONE person. Whole words only — "Business License" and "Driver Services" are company papers. */
const IDENTITY = [
  "passport", "passaporto", "id card", "idcard", "identity card", "identity document", "driver licen[cs]e", "driver s licen[cs]e", "drivers licen[cs]e",
  "driving licen[cs]e", "carta d identit[a-z]*", "birth cert[a-z]*", "visa", "i 94", "w 7", "itin", "ssn", "social security", "proof of address",
  "utility bill", "w 8 ben", "8843",
]
/** Forms that carry a person's tax id: SS-4 names a responsible person; 1040 / 1040-NR are an individual's return. */
const PERSONAL_FORM = ["ss 4", "1040(?: nr| sr| x)?"]

const wholeWords = (alts: string[]) => new RegExp(`(?:^| )(?:${alts.join("|")})(?: |$)`)
const IDENTITY_RE = wholeWords(IDENTITY)
const FORM_RE = wholeWords(PERSONAL_FORM)

export type PersonalKind = "identity" | "form" | null

/** Pure: is this file name a person's own paper? "identity" = never in client storage; "form" = saved, but kept off the company's Documents tab. */
export function personalKind(fileName: string): PersonalKind {
  const n = normalizeFaxName(fileName)
  if (IDENTITY_RE.test(n)) return "identity"
  if (FORM_RE.test(n)) return "form"
  return null
}

/**
 * A person's own paper in either sense. CONSERVATIVE: a company return (1120, 1065, 5472 …) is not personal. Used by the
 * "Don't save" copy (a personal paper keeps the bucket copy but is attached to NO company).
 */
export function looksPersonal(fileName: string): boolean {
  return personalKind(fileName) !== null
}
