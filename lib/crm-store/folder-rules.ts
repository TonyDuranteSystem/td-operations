/**
 * Pure folder rules (no database) shared by the structure code, the browse listing and the tests.
 * THIS FILE IS THE ONE PLACE that says which folder may be renamed / moved / deleted; the server (structure.ts) enforces it and the
 * page only shows what the server's folder summary says.
 */

/** A folder kind staff create by hand. Every other kind is a standard folder (template folders and tax-year folders). */
export const CUSTOM_KIND = "custom"

export const YEAR_FOLDER_KINDS = ["tax_year", "person_tax_year"] as const

/** The store keeps `period_year` between these (CHECK on store_files) — a year folder outside it would make every save into it fail. */
export const MIN_PERIOD_YEAR = 1990
export const MAX_PERIOD_YEAR = 2100

/** True for a tax-year folder kind (company or person). */
export const isYearFolderKind = (kind: string | null | undefined): boolean => !!kind && (YEAR_FOLDER_KINDS as readonly string[]).includes(kind)

/** What is inside a folder, for the rules that only allow an EMPTY folder to change. Missing numbers = not read: the rule then refuses (never guesses). */
export interface FolderContents { liveFiles?: number; subFolders?: number }
const isEmpty = (c: FolderContents | undefined): boolean => !!c && c.liveFiles === 0 && c.subFolders === 0

interface FolderLike { template_slug: string | null; parent_id: string | null; kind?: string | null }

/**
 * The MOVE lock: a folder made by a template (the client's top folder, the standard company / person folders, Business / My files),
 * the top of a storage, or any standard kind is never moved — a tax-year folder included (it keeps its meaning only inside its Tax
 * folder). Renaming / deleting a tax-year folder is a separate, narrower rule: `folderRenameRefusal` / `folderDeleteRefusal`.
 * `kind` is optional so older callers that only know the template/parent keep their answer.
 */
export function isLockedFolder(f: FolderLike): boolean {
  return f.template_slug !== null || f.parent_id === null || (!!f.kind && f.kind !== CUSTOM_KIND)
}

/** A template / standard folder that is NOT a tax-year folder: never renamed, moved or deleted, whatever it holds. */
export function isFixedFolder(f: FolderLike): boolean {
  return f.template_slug !== null || f.parent_id === null || (!!f.kind && f.kind !== CUSTOM_KIND && !isYearFolderKind(f.kind))
}

/** A plain-English reason a folder cannot be MOVED, or null when it can. */
export function folderMoveRefusal(f: FolderLike & { name: string }): string | null {
  return isLockedFolder(f) ? `"${f.name}" is one of the fixed folders and can't be moved.` : null
}

/** A plain-English reason a folder cannot be RENAMED, or null when it can. A tax-year folder only while it is empty. */
export function folderRenameRefusal(f: FolderLike & { name: string }, contents?: FolderContents): string | null {
  if (isFixedFolder(f)) return `"${f.name}" is one of the fixed folders and can't be renamed.`
  if (isYearFolderKind(f.kind) && !isEmpty(contents)) return `"${f.name}" is a tax-year folder with files or folders in it — it can only be renamed while it is empty.`
  return null
}

/** A plain-English reason a folder cannot be deleted, or null when it can. Checked BEFORE anything is hidden or removed. */
export function folderDeleteRefusal(
  f: { name: string; kind: string; template_slug: string | null; parent_id: string | null },
  descendantKinds: string[],
  contents?: FolderContents,
): string | null {
  if (isFixedFolder(f)) return `"${f.name}" is one of the fixed folders and can't be deleted.`
  if (isYearFolderKind(f.kind)) return isEmpty(contents) ? null : `"${f.name}" is a tax-year folder with files or folders in it — it can only be deleted while it is empty.`
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
