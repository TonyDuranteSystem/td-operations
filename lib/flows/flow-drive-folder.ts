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
