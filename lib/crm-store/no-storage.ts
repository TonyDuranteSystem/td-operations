/**
 * CRM Store — the one sentence for "this company has no storage" (Stop Drive, dev job 264bb882, slice S1c).
 *
 * Every document save goes to the CRM storage. A company that has none and is finished (Closed / Cancelled) or has no folder
 * at all cannot receive a new file — the action says so in ONE plain sentence. The few companies deliberately left as they
 * are (a folder, no storage, not finished) keep their old behaviour (see decideNoStorage below). It is not a notice, a label or
 * a banner: it is the answer of the action that was asked for. Nothing is skipped silently.
 */

export const NO_STORAGE_SENTENCE = "This company has no document storage in the CRM, so this file could not be saved."

/** A person (not a company) with no storage: same idea, same single sentence. */
export const NO_PERSON_STORAGE_SENTENCE = "This person has no document storage in the CRM, so this file could not be saved."

/** The HTTP status for it: the request is fine, the company's state does not allow it (409 — same as a company being moved). */
export const NO_STORAGE_STATUS = 409

/** True when a save routed through `saveDocumentForAccount` / `saveDocumentForContact` did NOT land in storage. */
export function notStored(routed: { route: string }): boolean {
  return routed.route !== "store"
}

// ─── A company with NO storage: which of the two answers? ──────────────────────────────────────────────────────────
//
// Antonio 2026-10-18: four companies were deliberately left as they are (REBIS, YBR, Degasper, Fresh Legal: status Active /
// Suspended / Offboarding, they HAVE a Drive folder and NO storage). They must keep working exactly as before. Everything else
// that has no storage — a Closed or Cancelled company, or a company with no folder at all — gets the one sentence.

export type NoStorageDecision = { route: "drive"; folderId: string } | { route: "refuse" }

/** Statuses of a finished company: never written to, whatever folder it still has. */
const FINISHED_STATUSES = new Set(["closed", "cancelled", "canceled"])

/** Pure: the folder id from the two places a company keeps it. */
export function folderIdOf(a: { drive_folder_id?: string | null; gdrive_folder_url?: string | null }): string | null {
  if (a.drive_folder_id) return a.drive_folder_id
  const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(a.gdrive_folder_url ?? "")
  return m ? m[1] : null
}

/** Pure: keep the company's own folder only when it is not finished AND has a folder. */
export function decideNoStorage(a: { status?: string | null; drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null | undefined): NoStorageDecision {
  if (!a) return { route: "refuse" }
  if (FINISHED_STATUSES.has(String(a.status ?? "").trim().toLowerCase())) return { route: "refuse" }
  const folderId = folderIdOf(a)
  return folderId ? { route: "drive", folderId } : { route: "refuse" }
}

/** Strict read (a read error throws — it is never mistaken for "no folder"). Call ONLY after a save came back `route: "drive"`. */
export async function noStorageDecisionFor(accountId: string): Promise<NoStorageDecision> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { data, error } = await supabaseAdmin.from("accounts").select("status, drive_folder_id, gdrive_folder_url").eq("id", accountId).maybeSingle()
  if (error) throw new Error("Could not check this company — please try again.")
  return decideNoStorage(data as { status?: string | null; drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null)
}

/**
 * Can a new file for this company be saved at all? (storage, or a company left on its old folder) — decided BEFORE a caller
 * changes anything else, so a refusal never leaves a half-done update behind. Strict: a read error throws.
 */
export async function accountCanReceiveFiles(accountId: string): Promise<boolean> {
  const { companyDocState } = await import("./switched-drive-guard")
  if ((await companyDocState(accountId)) !== "drive") return true
  return (await noStorageDecisionFor(accountId)).route === "drive"
}

/** Pure: is this a finished (Closed / Cancelled) company status? */
export function isFinishedStatus(status: string | null | undefined): boolean {
  return FINISHED_STATUSES.has(String(status ?? "").trim().toLowerCase())
}

/** Strict read: is this company Closed / Cancelled? (a read error throws) */
export async function accountIsFinished(accountId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { data, error } = await supabaseAdmin.from("accounts").select("status").eq("id", accountId).maybeSingle()
  if (error) throw new Error("Could not check this company — please try again.")
  return isFinishedStatus((data as { status?: string | null } | null)?.status)
}

/** What a CLIENT is told when a file cannot be saved for their company (no staff wording, no internals). */
export const CLIENT_NO_STORAGE_SENTENCE = "We could not save this file. Please contact us."
