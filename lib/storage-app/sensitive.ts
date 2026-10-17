/**
 * Which documents a Mac must NEVER download (Antonio, 2026-10-17: "Sensitive documents: not downloadable to the Macs").
 * PURE and enforced on the SERVER — the app is told, but the file route answers "open it in the CRM" whatever the app does.
 *
 * Sensitive = passports, IDs and the ITIN papers (slugs of the document-type catalog), plus ANY file with no type inside a
 * PERSON's storage (an untyped file there could be a passport nobody has typed yet). The list is a decision of Antonio's;
 * a type is added here only when he says so.
 */
export const SENSITIVE_DOCUMENT_TYPES: readonly string[] = [
  "passport", "id_document", "itin_letter", "form_w_7", "form_1040_nr", "itin_application", "itin_schedule_oi",
]

export function isSensitiveForDevice(p: { documentType: string | null | undefined; ownerKind: string | null | undefined }): boolean {
  const t = (p.documentType ?? "").trim().toLowerCase()
  if (t) return SENSITIVE_DOCUMENT_TYPES.includes(t)
  return p.ownerKind === "person"
}

export const OPEN_IN_CRM_MESSAGE = "This document is not downloaded to a Mac. Open it in the CRM."
