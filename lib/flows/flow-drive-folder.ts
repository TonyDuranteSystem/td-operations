/**
 * Drive-folder resolution for flow (workspace) document uploads.
 *
 * Account-scoped flows file into the account's Drive folder. Contact-scoped
 * flows (ITIN, in-flight formations — SD.account_id NULL) historically fell
 * back to Supabase Storage even in production, so e.g. an ITIN approval
 * letter never reached the client's Google Drive folder (Martin Csordas,
 * 2026-07-07). When the contact has a linked account WITH a Drive folder,
 * the upload should file there — the document row stays contact-scoped
 * (person-level), only the binary's home borrows the company folder.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { interpolateStringStrict } from "@/lib/template-interpolation"

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"

/**
 * Apply an optional filename-rename template to a flow upload.
 *
 * - `renameTemplate` empty/absent → keep the original name untouched.
 * - Otherwise interpolate `{token}`s (strict: any missing/empty token → null)
 *   against `context`; on null, FALL BACK to the original name (never emit a
 *   literal `{token}` or an empty/"null" name — e.g. a contact-scoped SD with
 *   no company_name keeps the uploaded filename).
 * - The ORIGINAL file extension is preserved. Extension = the substring from
 *   the last dot ONLY when that dot is past position 0 (so a dotless name like
 *   "scan" or a leading-dot dotfile does NOT produce a garbage extension).
 *
 * Pure. Unit-tested.
 */
export function deriveEffectiveFileName(
  renameTemplate: string | null | undefined,
  originalName: string,
  context: Record<string, unknown>,
): string {
  if (!renameTemplate || !renameTemplate.trim()) return originalName
  const base = interpolateStringStrict(renameTemplate, context)
  if (base === null || base.trim() === "") return originalName
  const dot = originalName.lastIndexOf(".")
  const ext = dot > 0 ? originalName.slice(dot) : ""
  if (!ext) return base
  return base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base}${ext}`
}

/** Drive listing shape returned by listFolderAnyDrive. */
type DriveListResult = { files?: { id: string; name: string; mimeType: string }[] }
type DriveLister = (folderId: string) => Promise<DriveListResult>

/**
 * Resolve a named subfolder (e.g. "1. Company") directly under `parentFolderId`.
 * Matching is trim + case-insensitive so legacy folders like "1.Company" or a
 * trailing-space name still resolve. Returns `matched:false` (and null id) when
 * the folder isn't found OR the listing fails — callers then file into the
 * parent (root) and should LOG the fallback so a misfiled EIN letter is visible.
 *
 * Note: lists up to 100 children (the underlying cap). The standard account
 * folder has 5 subfolders, well within that; a genuinely truncated listing
 * degrades to the safe root fallback rather than a wrong folder.
 *
 * `lister` is injectable for unit tests; defaults to listFolderAnyDrive.
 */
export async function resolveSubfolderId(
  parentFolderId: string,
  subfolderName: string,
  lister?: DriveLister,
): Promise<{ id: string | null; matched: boolean }> {
  const list =
    lister ??
    (async (id: string) => {
      const { listFolderAnyDrive } = await import("@/lib/google-drive")
      return (await listFolderAnyDrive(id, 100)) as DriveListResult
    })
  let res: DriveListResult
  try {
    res = await list(parentFolderId)
  } catch (e) {
    console.warn(
      `[resolveSubfolderId] listing failed for ${parentFolderId}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return { id: null, matched: false }
  }
  const target = subfolderName.trim().toLowerCase()
  const match = (res?.files ?? []).find(
    (f) => f.mimeType === DRIVE_FOLDER_MIME && (f.name ?? "").trim().toLowerCase() === target,
  )
  return { id: match?.id ?? null, matched: !!match }
}

/**
 * Extract a usable Drive folder id from an account row: prefer the explicit
 * drive_folder_id, else parse it out of gdrive_folder_url. Pure.
 */
export function extractDriveFolderId(
  account: { drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null | undefined,
): string | null {
  if (!account) return null
  if (account.drive_folder_id) return account.drive_folder_id
  const url = account.gdrive_folder_url
  if (url) {
    const match = url.match(/folders\/([a-zA-Z0-9_-]+)/)
    if (match) return match[1]
  }
  return null
}

/**
 * Drive folder of the contact's primary linked account (is_primary first,
 * account_id as a stable tiebreaker — account_contacts has no created_at),
 * skipping linked accounts without a resolvable folder. Null when the
 * contact has no linked account with a Drive folder.
 */
export async function resolveContactLinkedDriveFolder(contactId: string): Promise<string | null> {
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id, is_primary, accounts(drive_folder_id, gdrive_folder_url)")
    .eq("contact_id", contactId)
    .order("is_primary", { ascending: false })
    .order("account_id", { ascending: true })

  for (const link of links ?? []) {
    // PostgREST returns the joined row as an object (FK join), but the
    // generated types allow an array — normalize both shapes.
    const raw = (link as { accounts?: unknown }).accounts
    const account = (Array.isArray(raw) ? raw[0] : raw) as
      | { drive_folder_id?: string | null; gdrive_folder_url?: string | null }
      | null
      | undefined
    const folderId = extractDriveFolderId(account)
    if (folderId) return folderId
  }
  return null
}
