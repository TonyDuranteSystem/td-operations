/**
 * Plain wording for the places that still touch Drive after the cutover (dev job 2d26a2df, Batch C).
 * Drive is a read-only archive + one-way backup for a company already in the CRM storage.
 */

/** The contact page's Drive link: the OLD archive when the person's files live in storage, the real folder otherwise. */
export function driveLinkLabel(inStorage: boolean): { text: string; title: string } {
  return inStorage
    ? { text: "Old Drive archive", title: "Read-only archive of the files from before they moved to the CRM storage. Current files are in the storage on this page." }
    : { text: "Open in Drive", title: "Open this contact's Google Drive folder" }
}

/** Answer for "move a file in this company's Drive folder" when the company has no Drive folder: the truth depends on where it lives. */
export function moveWithoutDriveFolderAnswer(state: "drive" | "moving" | "store"): { status: number; error: string } {
  if (state === "drive") return { status: 400, error: "This account has no Drive folder linked" }
  return {
    status: 409,
    error: "This company's files live in the CRM storage, not in Google Drive — there is no Drive folder to move files in. Move files inside the company's storage instead.",
  }
}

/** Warning added to the MCP drive_search tool: Drive is the archive, the live copy of a switched company is in the CRM storage. */
export const DRIVE_ARCHIVE_WARNING =
  "Drive is now a read-only ARCHIVE + one-way backup for every company already in the CRM storage. The current copy of such a company's documents is in the CRM storage (storage_list / storage_read / doc_search), not here — a file found here may be old or a backup copy."

/** The file-move / contact-file messages for a person whose files live in storage. */
export const PERSON_IN_STORAGE_MESSAGE =
  "This person's files live in the CRM storage; Google Drive is a read-only archive for them. Nothing was processed — add or open the file in the storage on the contact's Documents tab."

/** The signed-PDF line for the e-sign support email. */
export function esignFilingLine(opts: { hasAccount: boolean; filingNeeded: boolean; filed: boolean }): string {
  if (!opts.hasAccount || !opts.filingNeeded) return "The signed PDF (with Certificate of Completion) is saved with the envelope."
  return opts.filed
    ? "The signed PDF (with Certificate of Completion) is filed in the client's documents."
    : "⚠️ The signed PDF (with Certificate of Completion) could NOT be filed in the client's documents — it is still saved with the envelope. Staff must file it by hand; a system error was logged."
}
