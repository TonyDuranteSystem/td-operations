/**
 * CRM Store — the two name/role normalisations the app needs before talking to the
 * database (foundation slice 1). They mirror SQL store_name_key / store_role_key exactly.
 *
 * Every ACCESS / VISIBILITY / SENDING rule lives in the database only (slice 3 —
 * scripts/migrations/20260925-1500-crm-store-s3-access.sql, called through
 * lib/crm-store/visibility.ts). A TypeScript copy of those rules drifted once and was
 * removed on 2026-09-25 (council): never re-add one.
 */

/** Same as SQL store_name_key: trim, Unicode NFC, lowercase. */
export function storeNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase()
}

/** Same as SQL store_role_key: trim, collapse whitespace/underscores to one space, lowercase. */
export function storeRoleKey(role: string | null | undefined): string {
  return (role ?? "").trim().replace(/[\s_]+/g, " ").toLowerCase()
}
