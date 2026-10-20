/**
 * CRM Store — the one sentence for "this company has no storage" (Stop Drive, dev job 264bb882, slices S1c + S2).
 *
 * Every document save goes to the CRM storage. A company that has none cannot receive a new file — the action says so in ONE plain
 * sentence. Since S2 there is NO exception: the four companies once left on their old Drive folder (REBIS, YBR, Degasper, Fresh
 * Legal) are frozen too — "these stay in Drive and stop" (Antonio, 2026-10-18): their old records stay a read-only archive and a
 * new file for them is added by hand. It is not a notice, a label or a banner: it is the answer of the action that was asked for.
 * Nothing is skipped silently.
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
// Suspended / Offboarding, they HAVE a Drive folder and NO storage). "These stay in Drive and stop": since S2 nothing is ever
// written to Drive for them either ("frozen"). Every company that has no storage gets a plain sentence with the true reason.

export type NoStorageReason = "moving" | "archived" | "no_folder" | "no_company" | "frozen"

/** The ONE plain sentence per reason (the answer of the action that was asked for — not a notice, label or banner). */
export const NO_STORAGE_REASON_SENTENCE: Record<NoStorageReason, string> = {
  moving: "This company's files are being moved to the CRM storage right now — please try again in a few minutes.",
  archived: "This company is closed, so nothing new can be saved for it.",
  no_folder: NO_STORAGE_SENTENCE,
  no_company: "This file has no company to be saved for, so it could not be saved.",
  frozen: "This company's files are in its old Google Drive folder, which is now read-only, so this file could not be saved. Add it by hand where it belongs.",
}

/** What a CLIENT is told while their company's files are being moved. */
export const CLIENT_MOVING_SENTENCE = "We are updating your documents right now. Please try again in a few minutes."

/** Since S2 the only answer is a refusal (the "drive" route no longer exists: nothing but the backup writes to Drive). */
export type NoStorageDecision = { route: "refuse"; reason: NoStorageReason; sentence: string }

const refuse = (reason: NoStorageReason): NoStorageDecision => ({ route: "refuse", reason, sentence: NO_STORAGE_REASON_SENTENCE[reason] })

/**
 * Statuses of a finished company: never written to, whatever folder it still has. `accounts.status` is a database enum, so the
 * labels are exactly these two (queries use them as they are — `ilike` does not work on an enum). The in-code check below is also
 * case-insensitive and accepts 'canceled', so a value from any other source (a form, an import) is read the same way.
 */
export const FINISHED_DB_LABELS = ["Closed", "Cancelled"] as const
const FINISHED_STATUSES = new Set<string>([...FINISHED_DB_LABELS.map((x) => x.toLowerCase()), "canceled"])

/** Pure: the folder id from the two places a company / person keeps it: `drive_folder_id`, else the id inside the older link. */
export function folderIdOf(a: { drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null | undefined): string | null {
  if (!a) return null
  if (a.drive_folder_id) return a.drive_folder_id
  return driveIdFromUrl(a.gdrive_folder_url)
}

/** The id in any Google Drive folder link: /folders/<id>, /drive/u/0/folders/<id>, open?id=<id>, ?id=<id> (also a folders link with extra query). */
export function driveIdFromUrl(url: string | null | undefined): string | null {
  const u = url ?? ""
  const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(u) ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(u)
  return m ? m[1] : null
}

/**
 * Pure: THE rule for a company that has no storage: always a refusal, with the true reason — finished (Closed / Cancelled), still on
 * its old Drive folder (frozen — read-only archive), or no folder at all.
 */
export function decideNoStorage(a: { status?: string | null; drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null | undefined): NoStorageDecision {
  if (!a) return refuse("no_company")
  if (FINISHED_STATUSES.has(String(a.status ?? "").trim().toLowerCase())) return refuse("archived")
  return folderIdOf(a) ? refuse("frozen") : refuse("no_folder")
}

/** Strict read (a read error throws — it is never mistaken for "no folder"). Call ONLY after a save came back `route: "drive"`. */
export async function noStorageDecisionFor(accountId: string): Promise<NoStorageDecision> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { data, error } = await supabaseAdmin.from("accounts").select("status, drive_folder_id, gdrive_folder_url").eq("id", accountId).maybeSingle()
  if (error) throw new Error("Could not check this company — please try again.")
  return decideNoStorage(data as { status?: string | null; drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null)
}

/**
 * An OPEN company (not Closed / Cancelled) with no storage and no folder — made by onboarding, "place client" or a standalone tax
 * intake — is not a dead end: its storage is opened here, so the save that asked can land in it. Closed / Cancelled companies and the
 * few left on their old folder are untouched (they have no folder to be missing, or are finished). Returns true when the company now
 * has a storage. Idempotent; a read error throws; a formation that already owns a storage is not duplicated (returns false).
 */
export async function openStorageForOpenCompany(accountId: string): Promise<boolean> {
  const { companyDocState } = await import("./switched-drive-guard")
  if ((await companyDocState(accountId)) !== "drive") return false
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { data, error } = await supabaseAdmin.from("accounts").select("company_name, status, drive_folder_id, gdrive_folder_url").eq("id", accountId).maybeSingle()
  if (error) throw new Error("Could not check this company — please try again.")
  if (!data) return false
  const d = decideNoStorage(data as { status?: string | null; drive_folder_id?: string | null; gdrive_folder_url?: string | null })
  if (d.route !== "refuse" || d.reason !== "no_folder") return false
  const { ensureCompanyStorage } = await import("./company-storage")
  try {
    await ensureCompanyStorage(accountId, (data as { company_name?: string | null }).company_name || "Company")
    return true
  } catch (e) {
    if (e instanceof Error && e.name === "FormationOwnerPendingError") return false
    throw e
  }
}

// The optional `undefined` members let a caller read `.reason` / `.sentence` without a narrowing step (the project is not strict).
export type ReceiveVerdict = { ok: true; reason?: undefined; sentence?: undefined } | { ok: false; reason: NoStorageReason; sentence: string }

/**
 * Can a new file for this company be saved at all — decided BEFORE a caller changes anything else, so a refusal never leaves a
 * half-done update behind. Storage → ok; a company being moved → not now (try again);
 * everything else (including a company frozen on its old Drive folder) → refused with the true reason. Strict: a read error throws.
 */
export async function receiveVerdictFor(accountId: string): Promise<ReceiveVerdict> {
  const { companyDocState } = await import("./switched-drive-guard")
  let state = await companyDocState(accountId)
  if (state === "drive" && (await openStorageForOpenCompany(accountId))) state = await companyDocState(accountId)
  if (state === "store") return { ok: true }
  if (state === "moving") return { ok: false, reason: "moving", sentence: NO_STORAGE_REASON_SENTENCE.moving }
  const d = await noStorageDecisionFor(accountId)
  return { ok: false, reason: d.reason, sentence: d.sentence }
}

/** Boolean form of `receiveVerdictFor` (a company being moved counts as "cannot receive right now"). */
export async function accountCanReceiveFiles(accountId: string): Promise<boolean> {
  return (await receiveVerdictFor(accountId)).ok
}

// ─── The same rule for a PERSON (a contact) ────────────────────────────────────────────────────────────────────────────

export interface ContactFacts {
  /** the person has their own live storage */
  liveOwner: boolean
  /** the person's own folder id (contacts.drive_folder_id / gdrive_folder_url) */
  folderId: string | null
  /** one verdict per company the person belongs to (see noStorageDecisionFor) */
  companyVerdicts: NoStorageDecision[]
  /** at least one company of theirs is in storage or being moved */
  companyInStorageOrMoving: boolean
}

/**
 * Pure: a person with no storage of their own is never written to in Drive (S2). The refusal names the true reason; a person of a
 * company that is only frozen on its old Drive folder is told so. Reuses the company rule above, so there is ONE definition.
 */
export function decideNoStorageForContact(f: ContactFacts): NoStorageDecision {
  const d = decideContactInner(f)
  // a person is not a "company": the refusal that names the missing storage speaks about the person
  return d.route === "refuse" && d.reason === "no_folder" ? { ...d, sentence: NO_PERSON_STORAGE_SENTENCE } : d
}

function decideContactInner(f: ContactFacts): NoStorageDecision {
  if (f.liveOwner || f.companyInStorageOrMoving) return refuse("no_folder")
  if (f.companyVerdicts.length === 0) return refuse(f.folderId ? "no_company" : "no_folder")
  if (f.companyVerdicts.some((v) => v.reason === "frozen")) return refuse("frozen")
  if (f.companyVerdicts.some((v) => v.reason === "archived")) return refuse("archived")
  return refuse("no_folder")
}

/** Strict read of everything `decideNoStorageForContact` needs for one person (a read error throws). */
export async function noStorageDecisionForContact(contactId: string): Promise<NoStorageDecision> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { liveOwnerOfContact, companyDocState } = await import("./switched-drive-guard")
  const { data: c, error } = await supabaseAdmin.from("contacts").select("drive_folder_id, gdrive_folder_url").eq("id", contactId).maybeSingle()
  if (error) throw new Error("Could not check where this person's files live — please try again.")
  const { data: links, error: lErr } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", contactId)
  if (lErr) throw new Error("Could not check where this person's files live — please try again.")
  const accountIds = ((links ?? []) as Array<{ account_id: string | null }>).map((l) => l.account_id).filter((x): x is string => !!x)
  let inStorageOrMoving = false
  const verdicts: NoStorageDecision[] = []
  for (const id of accountIds) {
    const st = await companyDocState(id)
    if (st !== "drive") { inStorageOrMoving = true; continue }
    verdicts.push(await noStorageDecisionFor(id))
  }
  return decideNoStorageForContact({
    liveOwner: !!(await liveOwnerOfContact(contactId)),
    folderId: folderIdOf(c as { drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null),
    companyVerdicts: verdicts,
    companyInStorageOrMoving: inStorageOrMoving,
  })
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
