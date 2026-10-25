/**
 * Pure folder rules (no database) shared by the structure code, the browse listing and the tests.
 */

/** A folder kind staff create by hand. Every other kind is a standard folder (template folders and tax-year folders). */
export const CUSTOM_KIND = "custom"

export const YEAR_FOLDER_KINDS = ["tax_year", "person_tax_year"] as const

/** The store keeps `period_year` between these (CHECK on store_files) — a year folder outside it would make every save into it fail. */
export const MIN_PERIOD_YEAR = 1990
export const MAX_PERIOD_YEAR = 2100

/**
 * A folder staff cannot rename, move or delete: made by a template (the client's top folder, the standard company / person
 * folders, Business / My files), the top of a storage, or any standard kind — a tax-year folder is its own kind (a file saved in
 * it is known to be for that year), so renaming it would break that and deleting it is not something the store's trash accepts.
 * `kind` is optional so older callers that only know the template/parent keep their answer.
 */
export function isLockedFolder(f: { template_slug: string | null; parent_id: string | null; kind?: string | null }): boolean {
  return f.template_slug !== null || f.parent_id === null || (!!f.kind && f.kind !== CUSTOM_KIND)
}

/** A plain-English reason a folder cannot be deleted, or null when it can. Checked BEFORE anything is hidden or removed. */
export function folderDeleteRefusal(
  f: { name: string; kind: string; template_slug: string | null; parent_id: string | null },
  descendantKinds: string[],
): string | null {
  if (f.parent_id === null || f.template_slug !== null) return `"${f.name}" is one of the fixed folders and can't be deleted.`
  if ((YEAR_FOLDER_KINDS as readonly string[]).includes(f.kind)) return "A tax-year folder cannot be deleted from here."
  if (f.kind !== CUSTOM_KIND) return `"${f.name}" is a standard folder and can't be deleted.`
  if (descendantKinds.some((k) => k !== CUSTOM_KIND)) return `"${f.name}" contains a standard or tax-year folder, so it can't be deleted from here. Empty or move the folders you made yourself instead.`
  return null
}

/** Parse a tax-year folder name: four digits inside the store's year range, else null. */
export function parseYearFolderName(name: string): number | null {
  const t = name.trim()
  if (!/^\d{4}$/.test(t)) return null
  const n = Number(t)
  return n >= MIN_PERIOD_YEAR && n <= MAX_PERIOD_YEAR ? n : null
}

export const YEAR_RANGE_MESSAGE = `Enter a four-digit year between ${MIN_PERIOD_YEAR} and ${MAX_PERIOD_YEAR}, e.g. 2025.`
