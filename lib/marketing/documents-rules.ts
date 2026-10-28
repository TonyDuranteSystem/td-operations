/**
 * TD Marketing — Documents (pure; dev job 9aec66fa; Antonio, 27 Oct 2026: a tab where the team's documents live, "something we can upload, edit, download and connected to our storage", in a
 * new "Marketing" folder inside Business). Names, limits and the file-name checks; no database here.
 */

/** The folder inside the firm's Business storage that this tab shows (and never leaves). */
export const MARKETING_DOCS_FOLDER = "Marketing"
/** the staging area every storage upload passes through (the same one the Storage page uses) */
export const DOCS_STAGING_BUCKET = "onboarding-uploads"
export const DOCS_STAGING_PREFIX = "crm-uploads/store-staging/"
export const DOC_MAX_MB = 200
export const DOC_MAX_BYTES = DOC_MAX_MB * 1024 * 1024

/** Programs and scripts are not documents: nobody uploads them here. */
const BLOCKED = /\.(exe|app|bat|cmd|com|scr|msi|dmg|pkg|sh|js|jar|vbs|ps1|apk|bin|dll)$/i

/** Why this file cannot be put here, in plain words; null = fine. */
export function docRefusal(name: string, size: number): string | null {
  const n = (name ?? "").trim()
  if (!n || n.length > 200) return "Choose a file with a name of up to 200 characters."
  if (/[\\/\u0000-\u001f]/.test(n)) return "The file name cannot contain slashes or control characters."
  if (BLOCKED.test(n)) return "Programs and scripts cannot be uploaded here. Upload a document."
  if (!Number.isFinite(size) || size <= 0) return "That file is empty."
  if (size > DOC_MAX_BYTES) return `That file is too large (${(size / 1024 / 1024).toFixed(1)} MB). The most you can upload is ${DOC_MAX_MB} MB.`
  return null
}

/** A file name safe to put in a storage path (the stored name keeps the real one). */
export function safeObjectName(name: string): string {
  const base = (name ?? "file").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-80)
  return base || "file"
}

/** The staging path of one upload: under the Business storage's own owner folder, never guessable. */
export function stagingPathFor(ownerId: string, fileName: string, now: Date, random: string): string {
  return `${DOCS_STAGING_PREFIX}${ownerId}/${now.getTime()}_${random}_${safeObjectName(fileName)}`
}

/** Is this staging path one this feature issued for this storage? (never another storage's, never a path with ..) */
export function isOwnStagingPath(path: string, ownerId: string): boolean {
  return typeof path === "string" && path.startsWith(`${DOCS_STAGING_PREFIX}${ownerId}/`) && !path.includes("..") && !path.slice(DOCS_STAGING_PREFIX.length + ownerId.length + 1).includes("/")
}

export const canReadDocuments = (perms: readonly string[]): boolean => perms.includes("documents") || perms.includes("documents.manage")
export const canManageDocuments = (perms: readonly string[]): boolean => perms.includes("documents.manage")

/** A plain size for the list: "84 KB", "3.2 MB". */
export function formatDocSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
