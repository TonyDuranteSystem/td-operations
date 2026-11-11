/**
 * Which kinds of file a wizard's "document" boxes take (production end-to-end test 2026-11-10, finding F1: the closure wizard took a ".txt" as the
 * company's Articles). The browser's file picker can be skipped, so the SERVER mints the upload path only for an acceptable name — same place as the
 * bank-statement / tax-return rules in wizard-upload-url and wizard-upload.
 *
 * Only the boxes that hold an official paper or an identity document are guarded: the Articles, the IRS EIN letter, the SS-4 and the passports.
 * They must be a PDF, a picture a phone or scanner makes, or a Word file. "Other documents", proof of address and the rest stay open.
 * A name with no extension at all is let through (a phone can name a file that way) — the files are read by people afterwards anyway.
 *
 * Pure — no I/O.
 */

/** The wizard boxes that must hold a real document or picture. */
export const WIZARD_DOCUMENT_FIELDS: readonly string[] = [
  "articles_of_organization",
  "ein_letter",
  "ss4_form",
  "passport_owner",
  "member_passport",
  "passport_image",
]

/** What those boxes take: a PDF, a picture (including an iPhone HEIC photo and a TIFF scan) or a Word file. */
export const WIZARD_DOCUMENT_EXTENSIONS: readonly string[] = ["pdf", "png", "jpg", "jpeg", "jpe", "jfif", "heic", "heif", "webp", "avif", "tif", "tiff", "gif", "bmp", "doc", "docx"]

/** Value for the file picker's `accept` attribute (a convenience for the client; the server rule is the control). */
export const WIZARD_DOCUMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.jpe,.jfif,.heic,.heif,.webp,.avif,.tif,.tiff,.gif,.bmp,.doc,.docx,application/pdf,image/*"

/** The boxes above, and the per-member passport boxes a company with several owners gets (`member_<n>_member_passport`). */
export function isWizardDocumentField(fieldName: string): boolean {
  return WIZARD_DOCUMENT_FIELDS.includes(fieldName) || /^member_\d+_member_passport$/.test(fieldName)
}

/** `null` when the file may go in this box, else a sentence for the client (English, then Italian — the wizard is bilingual). */
export function wizardFileTypeProblem(fieldName: string, fileName: string): string | null {
  if (!isWizardDocumentField(fieldName)) return null
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName ?? "").trim())
  if (!m) return null
  const ext = m[1].toLowerCase()
  if (WIZARD_DOCUMENT_EXTENSIONS.includes(ext)) return null
  return (
    `This box needs a PDF or a picture of the document (for example PDF, JPG, PNG or a phone photo) — a ".${ext}" file cannot be used here. ` +
    `Questo campo richiede un PDF o una foto del documento (ad esempio PDF, JPG, PNG o una foto dal telefono): un file ".${ext}" non può essere usato qui.`
  )
}
