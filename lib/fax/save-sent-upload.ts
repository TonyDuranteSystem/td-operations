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

/** Pure: the file name as lowercase words separated by single spaces (accents removed; also splits camelCase, ACRONYMName and letter↔digit). */
export function normalizeFaxName(fileName: string): string {
  return fileName
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")        // "Identità" → "Identita"
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")                   // "ITINRossi" → "ITIN Rossi"
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
}

/**
 * Identity and residence papers: they belong to ONE person. Whole words only — "Business License", "Driver Services", "Tax ID" and
 * "Identity Verification Services" are company papers. English and Italian (Italian clients are common), plus the common Spanish and
 * French forms. NAMES IN OTHER SCRIPTS (Cyrillic, Chinese, Arabic …) CANNOT BE CHECKED by this list: the window is the protection there
 * (an identity paper is never offered a client's storage by the proposal rules), and staff must not choose one by hand.
 */
const IDENTITY = [
  "passport", "passaporto", "id card", "idcard", "photo id", "identity card", "identity document", "identity(?! (?:verification|theft|protection|services|access|management))",
  "driver licen[cs]e", "driver s licen[cs]e", "drivers licen[cs]e", "driving licen[cs]e", "green card", "ead", "residence permit", "ss 5",
  "carta d? ?identit[a-z]*", "documento d? ?identit[a-z]*", "patente", "codice fiscale", "tessera sanitaria", "permesso di soggiorno",
  "birth cert[a-z]*", "visa", "i 94", "w 7", "itin", "ssn", "social security", "proof of address", "utility bill", "w 8 ben", "8843",
  // a lone "ID" ANYWHERE as a whole word (ID_Rossi, Rossi_ID_front, ID front, Rossi_ID_2024.webp) — but not "Tax ID" / "Employer ID" /
  // "Company ID" letters. A "State ID" IS an identity card. The safe side: a false block only makes staff pick Business / My files /
  // "Don't save"; a miss would put someone's ID in a company's storage.
  "(?<!(?:tax|employer|company|invoice|order|case|file|member|client|user|customer|account|transaction|reference|policy|project|ticket|booking|payment|tracking|session|device|network|ein|document|record|batch|job) )id",
  // abbreviations: driver's licence, Italian carta d'identità, residence card / permit without "of"
  "dl", "ci", "residence card", "permesso soggiorno", "carta soggiorno",
  // Spanish / French (the same safe side): DNI, cédula, pasaporte, licencia de conducir, passeport, permis de conduire
  "dni", "cedula", "pasaporte", "passeport", "licencia de conducir", "licencia conducir", "permis de conduire",
]
/** Long words that also count when GLUED to other text in lower case ("rossipassport.pdf", "cartaidentita.pdf"): matched on the name without spaces. */
const GLUED_IDENTITY = /(passport|passaporto|pasaporte|passaporte|passeport|identita|patente|soggiorno|codicefiscale|tesserasanitaria|greencard|driverlicen|drivinglicen|idfront|idback|idcard|idcopy|idscan|ssncard|ssnscan|ssncopy)/
/** Forms that carry a person's tax id: SS-4 names a responsible person; 1040 / 1040-NR are an individual's return. */
const PERSONAL_FORM = ["ss 4", "1040(?: nr| sr| x)?"]

const wholeWords = (alts: string[]) => new RegExp(`(?:^| )(?:${alts.join("|")})(?: |$)`)
const IDENTITY_RE = wholeWords(IDENTITY)
const FORM_RE = wholeWords(PERSONAL_FORM)

export type PersonalKind = "identity" | "form" | null

/** Pure: is this file name a person's own paper? "identity" = never in client storage; "form" = saved, but kept off the company's Documents tab. */
export function personalKind(fileName: string): PersonalKind {
  const n = normalizeFaxName(fileName)
  if (IDENTITY_RE.test(n) || GLUED_IDENTITY.test(n.replace(/ /g, ""))) return "identity"
  if (FORM_RE.test(n)) return "form"
  return null
}

/**
 * A person's own paper in either sense. CONSERVATIVE: a company return (1120, 1065, 5472 …) is not personal. (The internal copy of a
 * fax is NEVER attached to a company; an identity paper gets no internal copy at all — see the send route.)
 */
export function looksPersonal(fileName: string): boolean {
  return personalKind(fileName) !== null
}
