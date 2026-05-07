/**
 * Resolve the public Google Drive folder URL for an account.
 *
 * `accounts.drive_folder_id` is the canonical column used by every server-side
 * flow (fileRenewal, closure, banking, welcome-package, signature). The legacy
 * `accounts.gdrive_folder_url` column is retained but is NULL on accounts
 * created/migrated after it stopped being populated. UI code that needs a
 * clickable Drive link must consult both — this helper builds a URL from
 * whichever column is set, preferring the explicit URL when present.
 */
export function resolveDriveFolderUrl(
  gdriveUrl: string | null | undefined,
  driveFolderId: string | null | undefined,
): string | null {
  if (gdriveUrl) return gdriveUrl
  if (driveFolderId) return `https://drive.google.com/drive/folders/${driveFolderId}`
  return null
}
