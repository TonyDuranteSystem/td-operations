/**
 * Caller-key prefixes that mean "SIGNED document" — a file saved under one of these takes no new version (database setting
 * `app_settings.store_signed_key_prefixes`, read by `store_lock_class`). This list MIRRORS the setting as written by
 * scripts/migrations/20261025-1200-storage-safe-save.sql + 20261025-1500-storage-signed-prefixes.sql; tests/unit/crm-store-signed-prefixes.test.ts
 * checks that every signed producer in the code is listed here AND in the migration.
 */
export const SIGNED_KEY_PREFIXES = [
  "esign-signed:",
  "offer-signed:",
  "lease-signed:",
  "oa-signed:",
  "ss4-signed-company:",
  "8832-signed:",
  "signature-signed:",
  "oa-handsigned-scan:",
  "ss4-signed:",
] as const

/**
 * Producers that go through saveSignedPdfForAccount but are NOT signed documents (generated or unsigned copies, kept editable
 * in place on purpose). Anything new must be added to SIGNED_KEY_PREFIXES (and the setting) or listed here with its reason.
 */
export const NOT_SIGNED_KEY_PREFIXES = {
  "oa-handsigned-draft:": "the unsigned copy of the OA (the client signed by hand on paper); the executed scan is oa-handsigned-scan:",
  "ss4-irs-package:": "the generated SS-4 + Articles fax package, rebuilt on every re-sign",
  "ownership-attestation:": "the generated attestation, regenerated from CRM data (staff send it for signature separately)",
  "ss4-unsigned:": "the unsigned SS-4 saved while it waits for the client's signature",
  "intercompany:":"the generated intercompany agreement, regenerated from CRM data",
} as const
