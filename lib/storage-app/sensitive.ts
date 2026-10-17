/**
 * Which documents a Mac must NEVER download (Antonio, 2026-10-17: "Sensitive documents: not downloadable to the Macs").
 * PURE and enforced on the SERVER — the app is told, but the file route answers "open it in the CRM" whatever the app does.
 *
 * Sensitive =
 *  1. the identity / ITIN document TYPES (slugs of the document-type catalog): passports, IDs, W-7 (and its certificate-of-acceptance
 *     copy), 1040-NR, ITIN letter / application / Schedule OI;
 *  2. ANY file with no type inside a PERSON's storage (an untyped file there could be a passport nobody has typed yet);
 *  3. an UNTYPED file anywhere else whose NAME looks like one of those papers (production has hundreds of untyped company files, some of
 *     them ITIN / W-7 material) — until someone types it, it opens in the CRM only.
 * The list is a decision of Antonio's; a type is added here only when he says so. (Not covered, on purpose: types like irs_notice_personal
 * — Antonio has not decided.)
 */
export const SENSITIVE_DOCUMENT_TYPES: readonly string[] = [
  "passport", "id_document", "itin_letter", "form_w_7", "form_w_7_coa", "form_1040_nr", "itin_application", "itin_schedule_oi",
]

const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /\bitin\b/, /\bw ?7\b/, /\bpassport\b/, /\bpassaporto\b/, /\bssn\b/, /social security/, /driver s? licen[cs]e/, /\bid (card|document)\b/,
  /\bidentit/, /carta d ?identit/, /permesso di soggiorno/, /codice fiscale/, /\b1040 ?nr\b/, /schedule oi\b/,
]

/** PURE: does a file NAME look like an identity / ITIN paper? Separators (_ - . parentheses) count as spaces. */
export function looksSensitiveByName(name: string | null | undefined): boolean {
  const n = (name ?? "").toLowerCase().replace(/[_\-.()\[\]'’]+/g, " ").replace(/\s+/g, " ").trim()
  return !!n && SENSITIVE_NAME_PATTERNS.some((re) => re.test(n))
}

export function isSensitiveForDevice(p: { documentType: string | null | undefined; ownerKind: string | null | undefined; name?: string | null }): boolean {
  const t = (p.documentType ?? "").trim().toLowerCase()
  if (t) return SENSITIVE_DOCUMENT_TYPES.includes(t)
  if (p.ownerKind === "person") return true
  return looksSensitiveByName(p.name)
}

export const OPEN_IN_CRM_MESSAGE = "This document is not downloaded to a Mac. Open it in the CRM."
