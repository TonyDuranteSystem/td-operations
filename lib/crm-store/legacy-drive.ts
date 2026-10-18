/**
 * CRM Store — the ONE definition of "this company / person may still be written to in Google Drive" (Stop Drive, dev job 264bb882, slice S1d).
 *
 * Antonio (2026-10-18): everything points to the storage; the old Drive is an archive and the new "backup" folder mirrors the
 * storage. The only companies deliberately left on Drive are the few that have a Drive folder and no storage and are not
 * Closed / Cancelled (REBIS, YBR, Degasper, Fresh Legal at the time of writing) — their pre-existing Drive path must simply
 * keep working. Everything else writes NOTHING in Drive:
 *   - a company with storage (or mid-move)        → storage only
 *   - a Closed / Cancelled company                → read-only archive
 *   - a company with no storage and no Drive folder → nothing to write into, and no folder is ever created
 *
 * Every writer that still has a Drive branch asks `legacyDriveForAccount` / `legacyDriveForContact` first; a refusal is an
 * ERROR for the caller plus a staff-visible alarm (`raiseDriveWriteRefused`), never an "ok" and never a silent skip.
 */

export const ARCHIVE_ACCOUNT_STATUSES = ["Closed", "Cancelled"] as const

export type LegacyRefusalReason = "has_storage" | "moving" | "archived" | "no_folder" | "no_company"

/** The one plain sentence per reason (the answer of the action that was asked for — not a notice, label or banner). */
export const LEGACY_REFUSAL_SENTENCE: Record<LegacyRefusalReason, string> = {
  has_storage: "This company's files live in the CRM storage, so this file was not written anywhere else.",
  moving: "This company's files are being moved to the CRM storage right now — please try again in a few minutes.",
  archived: "This company is closed, so nothing new can be saved for it.",
  no_folder: "This company has no document storage in the CRM, so this file could not be saved.",
  no_company: "This file has no company to be saved for, so it could not be saved.",
}

// The optional `undefined` members let callers read `.reason` / `.folderId` without a narrowing step (this project's
// tsconfig is not strict, where a `true | false` tag does not narrow).
export type LegacyDriveVerdict =
  | { allowed: true; folderId: string; reason?: undefined; sentence?: undefined }
  | { allowed: false; reason: LegacyRefusalReason; sentence: string; folderId?: undefined }

export interface AccountFacts {
  /** accounts.status; null when the account does not exist */
  status: string | null
  driveFolderId: string | null
  /** companyDocState(): "drive" | "moving" | "store" */
  state: "drive" | "moving" | "store"
}

const refuse = (reason: LegacyRefusalReason): LegacyDriveVerdict => ({ allowed: false, reason, sentence: LEGACY_REFUSAL_SENTENCE[reason] })

/** Pure: may a NEW write go into this company's Drive folder? Only the left-on-Drive state: folder + no storage + not closed. */
export function decideLegacyAccount(f: AccountFacts | null): LegacyDriveVerdict {
  if (!f || f.status === null) return refuse("no_company")
  if (f.state === "store") return refuse("has_storage")
  if (f.state === "moving") return refuse("moving")
  if ((ARCHIVE_ACCOUNT_STATUSES as readonly string[]).includes(f.status)) return refuse("archived")
  if (!f.driveFolderId) return refuse("no_folder")
  return { allowed: true, folderId: f.driveFolderId }
}

export interface LegacyAccountDeps {
  load: (accountId: string) => Promise<AccountFacts | null>
}

async function defaultAccountDeps(): Promise<LegacyAccountDeps> {
  return {
    load: async (accountId) => {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      const { data, error } = await supabaseAdmin.from("accounts").select("status, drive_folder_id").eq("id", accountId).maybeSingle()
      if (error) throw new Error("Could not check where this company's files live — please try again.")
      if (!data) return null
      const { companyDocState } = await import("./switched-drive-guard")
      return { status: (data.status as string | null) ?? "", driveFolderId: (data.drive_folder_id as string | null) ?? null, state: await companyDocState(accountId) }
    },
  }
}

/** Strict (a read error throws — a write is never allowed on a guess). */
export async function legacyDriveForAccount(accountId: string | null | undefined, deps?: LegacyAccountDeps): Promise<LegacyDriveVerdict> {
  if (!accountId) return refuse("no_company")
  const d = deps ?? (await defaultAccountDeps())
  return decideLegacyAccount(await d.load(accountId))
}

export interface ContactFacts {
  liveOwner: boolean
  /** the person's own Drive folder id (contacts.drive_folder_id) */
  driveFolderId: string | null
  /** every company the person belongs to */
  accountIds: string[]
}

export interface LegacyContactDeps {
  load: (contactId: string) => Promise<ContactFacts>
  account: (accountId: string) => Promise<LegacyDriveVerdict>
}

/**
 * A person may still be written to in Drive only when they have no storage of their own, already have a Drive folder, and
 * belong to a company that is itself in the left-on-Drive state. Anyone else (a lead, a person of a company in storage or
 * closed, a person with no folder) gets their own storage (`saveDocumentForContact` opens it) — never a Drive folder.
 */
export async function legacyDriveForContact(contactId: string, deps?: LegacyContactDeps): Promise<LegacyDriveVerdict> {
  const d: LegacyContactDeps = deps ?? {
    load: async (id) => {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      const { liveOwnerOfContact } = await import("./switched-drive-guard")
      const { data: c, error } = await supabaseAdmin.from("contacts").select("drive_folder_id").eq("id", id).maybeSingle()
      if (error) throw new Error("Could not check where this person's files live — please try again.")
      const { data: links, error: lErr } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", id)
      if (lErr) throw new Error("Could not check where this person's files live — please try again.")
      return {
        liveOwner: !!(await liveOwnerOfContact(id)),
        driveFolderId: (c?.drive_folder_id as string | null | undefined) ?? null,
        accountIds: ((links ?? []) as Array<{ account_id: string | null }>).map((l) => l.account_id).filter((x): x is string => !!x),
      }
    },
    account: (accountId) => legacyDriveForAccount(accountId),
  }
  const f = await d.load(contactId)
  if (f.liveOwner) return refuse("has_storage")
  if (!f.driveFolderId) return refuse("no_folder")
  for (const accountId of f.accountIds) {
    const v = await d.account(accountId)
    if (v.allowed) return { allowed: true, folderId: f.driveFolderId }
  }
  return refuse(f.accountIds.length === 0 ? "no_company" : "archived")
}

/** The refusal as an error a caller can throw (message = the plain sentence). */
export class DriveWriteRefusedError extends Error {
  constructor(public reason: LegacyRefusalReason, sentence?: string) {
    super(sentence ?? LEGACY_REFUSAL_SENTENCE[reason])
    this.name = "DriveWriteRefusedError"
  }
}

/**
 * A write that was needed but is not allowed: tell staff (the system error log + the store's event history), return the plain
 * sentence for the caller to report. Never throws — the alarm must not hide the caller's own error.
 */
export async function raiseDriveWriteRefused(p: { flow: string; accountId?: string | null; contactId?: string | null; reason: LegacyRefusalReason; detail?: string }): Promise<string> {
  try {
    const { raisePilotAlarm } = await import("./formation-pilot")
    await raisePilotAlarm("drive_write_refused", { flow: p.flow, accountId: p.accountId ?? null, contactId: p.contactId ?? null, reason: p.reason, detail: p.detail ?? null })
  } catch { /* an alarm never breaks the caller */ }
  return LEGACY_REFUSAL_SENTENCE[p.reason]
}
