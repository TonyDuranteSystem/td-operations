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

import { decideNoStorage, folderIdOf, isFinishedStatus } from "./no-storage"

// ONE rule (Stop Drive S1c/S1d): "which companies may still be written to in Drive" is `decideNoStorage` in no-storage.ts (folder, no
// storage, not finished). This module adds only what a WRITER needs on top: the storage / moving states, the person variant, the
// staff alarm. The helpers below are that module's, re-exported under the names the S1d writers use.
export const isArchivedStatus = isFinishedStatus
export const folderIdOfRecord = folderIdOf

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
  const d = decideNoStorage({ status: f.status, drive_folder_id: f.driveFolderId })
  return d.route === "drive" ? { allowed: true, folderId: d.folderId } : refuse(d.reason === "moving" ? "no_folder" : d.reason)
}

export interface LegacyAccountDeps {
  load: (accountId: string) => Promise<AccountFacts | null>
}

async function defaultAccountDeps(): Promise<LegacyAccountDeps> {
  return {
    load: async (accountId) => {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      const { data, error } = await supabaseAdmin.from("accounts").select("status, drive_folder_id, gdrive_folder_url").eq("id", accountId).maybeSingle()
      if (error) throw new Error("Could not check where this company's files live — please try again.")
      if (!data) return null
      const { companyDocState } = await import("./switched-drive-guard")
      return { status: (data.status as string | null) ?? "", driveFolderId: folderIdOfRecord(data as { drive_folder_id?: string | null; gdrive_folder_url?: string | null }), state: await companyDocState(accountId) }
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
 * A person may still be written to in Drive only when they have no storage of their own and belong to a company deliberately
 * left on Drive (folder, no storage, not closed). Their folder is their own, or — if they never had one — that company's folder
 * (the same place the old staff upload used), so one person's papers are never split between Drive and a new storage while the
 * rest of their company stays in Drive. Anyone else (a lead, a person of a company in storage or closed) gets their own
 * storage (`saveDocumentForContact` opens it) — never a Drive folder. The refusal names the TRUE reason.
 */
export async function legacyDriveForContact(contactId: string, deps?: LegacyContactDeps): Promise<LegacyDriveVerdict> {
  const d: LegacyContactDeps = deps ?? {
    load: async (id) => {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      const { liveOwnerOfContact } = await import("./switched-drive-guard")
      const { data: c, error } = await supabaseAdmin.from("contacts").select("drive_folder_id, gdrive_folder_url").eq("id", id).maybeSingle()
      if (error) throw new Error("Could not check where this person's files live — please try again.")
      const { data: links, error: lErr } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", id)
      if (lErr) throw new Error("Could not check where this person's files live — please try again.")
      return {
        liveOwner: !!(await liveOwnerOfContact(id)),
        driveFolderId: folderIdOfRecord(c as { drive_folder_id?: string | null; gdrive_folder_url?: string | null } | null),
        accountIds: ((links ?? []) as Array<{ account_id: string | null }>).map((l) => l.account_id).filter((x): x is string => !!x),
      }
    },
    account: (accountId) => legacyDriveForAccount(accountId),
  }
  const f = await d.load(contactId)
  if (f.liveOwner) return refuse("has_storage")
  if (f.accountIds.length === 0) return refuse(f.driveFolderId ? "no_company" : "no_folder")
  const verdicts: LegacyDriveVerdict[] = []
  for (const accountId of f.accountIds) {
    const v = await d.account(accountId)
    if (v.allowed) return { allowed: true, folderId: f.driveFolderId ?? (v.folderId as string) }
    verdicts.push(v)
  }
  // none of their companies is a left-on-Drive one: say why (storage first, then a move in progress, then closed)
  for (const reason of ["has_storage", "moving", "archived"] as const) {
    if (verdicts.some((v) => v.reason === reason)) return refuse(reason)
  }
  return refuse("no_folder")
}

/** The refusal as an error a caller can throw (message = the plain sentence). */
export class LegacyDriveRefusedError extends Error {
  constructor(public reason: LegacyRefusalReason, sentence?: string) {
    super(sentence ?? LEGACY_REFUSAL_SENTENCE[reason])
    this.name = "LegacyDriveRefusedError"
  }
}

/** The same refusal (same flow, company / person and reason) alarms staff once per window — a retrying job cannot spam them. */
export const ALARM_THROTTLE_MS = 60 * 60 * 1000
const recentAlarms = new Map<string, number>()
export function forgetRecentAlarms(): void { recentAlarms.clear() }

/**
 * A write that was needed but is not allowed: tell staff (the system error log + the store's event history), return the plain
 * sentence for the caller to report. Never throws — the alarm must not hide the caller's own error. Throttled per
 * flow + company + person + reason (this server instance, and the store's own event history for other instances).
 */
export interface AlarmDeps {
  /** was the same refusal already alarmed (any server instance) since `sinceIso`? */
  alreadyAlarmed: (details: Record<string, unknown>, sinceIso: string) => Promise<boolean>
  raise: (details: Record<string, unknown>) => Promise<void>
}

async function defaultAlarmDeps(): Promise<AlarmDeps> {
  return {
    alreadyAlarmed: async (details, sinceIso) => {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_events is not in the generated types
      const { data } = await (supabaseAdmin as any).from("store_events").select("id").eq("event", "pilot_alarm").eq("reason", "drive_write_refused").gte("occurred_at", sinceIso).contains("details", details).limit(1)
      return Array.isArray(data) && data.length > 0
    },
    raise: async (details) => { const { raisePilotAlarm } = await import("./formation-pilot"); await raisePilotAlarm("drive_write_refused", details) },
  }
}

export async function raiseDriveWriteRefused(p: { flow: string; accountId?: string | null; contactId?: string | null; reason: LegacyRefusalReason; detail?: string }, now: number = Date.now(), deps?: AlarmDeps): Promise<string> {
  const sentence = LEGACY_REFUSAL_SENTENCE[p.reason]
  // one alarm per flow + company + person + reason + file/step: a retrying job cannot spam staff, but a refusal for a DIFFERENT file of
  // the same company is a different problem and is not silenced
  const key = [p.flow, p.accountId ?? "", p.contactId ?? "", p.reason, p.detail ?? ""].join("|")
  const last = recentAlarms.get(key)
  if (last !== undefined && now - last < ALARM_THROTTLE_MS) return sentence
  const d = deps ?? (await defaultAlarmDeps())
  const identity = { flow: p.flow, accountId: p.accountId ?? null, contactId: p.contactId ?? null, reason: p.reason, detail: p.detail ?? null }
  try {
    if (await d.alreadyAlarmed(identity, new Date(now - ALARM_THROTTLE_MS).toISOString())) { recentAlarms.set(key, now); return sentence }
  } catch { /* cannot tell: alarm anyway */ }
  try {
    await d.raise(identity)
    recentAlarms.set(key, now) // remembered only once the alarm really went out: a failed raise is tried again by the next refusal
  } catch { /* an alarm never breaks the caller */ }
  return sentence
}
