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
 * Identity and residence papers: they belong to ONE person. Whole words only. English and Italian (Italian clients are common), plus
 * the common Spanish and French forms. NAMES IN OTHER SCRIPTS (Cyrillic, Chinese, Arabic …) CANNOT BE CHECKED by this list: the window
 * is the protection there (an identity paper is never offered a client's storage by the proposal rules), and staff must not choose one by hand.
 * The SHORT ambiguous words (ID, DL, CI, CIE, visa, license) are NOT in this list — they only count in identity-looking context, below.
 */
const IDENTITY = [
  "passport", "passaporto", "id card", "idcard", "photo id", "state id", "identity card", "identity document", "identity(?! (?:verification|theft|protection|services|access|management))",
  "driver licen[cs]e", "driver s licen[cs]e", "drivers licen[cs]e", "driving licen[cs]e", "green card", "ead", "employment authorization", "residence permit", "residence card", "resident card",
  "ss 5", "i 9", "carta d? ?identit[a-z]*", "documento d? ?identit[a-z]*", "patente", "codice fiscale", "tessera sanitaria", "permesso di soggiorno",
  "permesso soggiorno", "carta soggiorno", "dni", "cedula", "pasaporte", "passeport", "licencia de conducir", "licencia conducir", "permis de conduire",
  "birth cert[a-z]*", "itin", "ssn", "social security", "proof of address", "utility bill", "w 7", "i 94", "w 8 ben", "8843",
]
/** Long words that also count when GLUED to other text in lower case ("rossipassport.pdf", "cartaidentita.pdf"): matched on the name without spaces. */
const GLUED_IDENTITY = /(passport|passaporto|pasaporte|passaporte|passeport|identita|patente|soggiorno|codicefiscale|tesserasanitaria|greencard|driverlicen|drivinglicen|idfront|idback|idcard|idcopy|idscan|ssncard|ssnscan|ssncopy)/

/**
 * The SHORT ambiguous words. "ID", "DL", "CI", "CIE", "visa" and "license" are also business words (Invoice ID, DL Services, CI Report,
 * Visa statement, Business License), so each counts only in identity-looking context:
 *  - next to a scan-like word (front, back, scan, photo, copy, image …) — "Rossi_ID_front", "ID front"; or
 *  - at the very START or END of the name (ignoring the file ending and a trailing number / year) AND the word beside it is not a business
 *    word — "Rossi_ID", "ID_Rossi", "DL_Rossi", "CI_Rossi", "CIE_Rossi", "Rossi_visa", "visa", "Rossi_license".
 * Never after Invoice / Order / Case / File / Member / Client / User / Customer / Tax / Employer …
 */
const LONE_WORDS = new Set(['id', 'dl', 'ci', 'cie', 'visa', 'license', 'licence'])
const SCAN_WORDS = new Set(['front', 'back', 'scan', 'scans', 'scanned', 'photo', 'picture', 'copy', 'image', 'selfie', 'jpg', 'jpeg', 'png'])
const BUSINESS_WORDS = new Set([
  'services', 'service', 'report', 'reports', 'statement', 'statements', 'payment', 'payments', 'card', 'cards', 'inc', 'llc', 'corp', 'ltd', 'co', 'company',
  'tax', 'employer', 'ein', 'invoice', 'order', 'case', 'file', 'member', 'client', 'user', 'customer', 'account', 'transaction', 'reference', 'policy', 'project',
  'ticket', 'booking', 'tracking', 'session', 'device', 'network', 'document', 'record', 'batch', 'job', 'fee', 'fees', 'charge', 'charges', 'receipt', 'receipts', 'bank',
  'business', 'software', 'agreement', 'renewal', 'application', 'professional', 'liquor', 'contractor', 'permit', 'fees',
])
const FILE_ENDINGS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'gif', 'webp', 'bmp', 'heic', 'doc', 'docx'])

/** Pure: does the short word sit in identity-looking context? (`normalized` = normalizeFaxName output) */
export function loneIdentityWordIn(normalized: string): boolean {
  const tokens = normalized.split(' ').filter(Boolean)
  while (tokens.length > 1 && FILE_ENDINGS.has(tokens[tokens.length - 1])) tokens.pop()
  while (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) tokens.pop()
  for (let i = 0; i < tokens.length; i++) {
    if (!LONE_WORDS.has(tokens[i])) continue
    const before = tokens[i - 1], after = tokens[i + 1]
    if ((before && BUSINESS_WORDS.has(before)) || (after && BUSINESS_WORDS.has(after))) continue
    if ((before && SCAN_WORDS.has(before)) || (after && SCAN_WORDS.has(after))) return true
    if (i === 0 || i === tokens.length - 1) return true
  }
  return false
}
/** Forms that carry a person's tax id: SS-4 names a responsible person; 1040 / 1040-NR are an individual's return. */
const PERSONAL_FORM = ["ss 4", "1040(?: nr| sr| x)?"]

const wholeWords = (alts: string[]) => new RegExp(`(?:^| )(?:${alts.join("|")})(?: |$)`)
const IDENTITY_RE = wholeWords(IDENTITY)
const FORM_RE = wholeWords(PERSONAL_FORM)

export type PersonalKind = "identity" | "form" | null

/** Pure: is this file name a person's own paper? "identity" = never in client storage; "form" = saved, but kept off the company's Documents tab. */
export function personalKind(fileName: string): PersonalKind {
  const n = normalizeFaxName(fileName)
  if (IDENTITY_RE.test(n) || GLUED_IDENTITY.test(n.replace(/ /g, "")) || loneIdentityWordIn(n)) return "identity"
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
