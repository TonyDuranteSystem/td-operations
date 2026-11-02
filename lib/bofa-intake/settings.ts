/**
 * Bank application intake — the two address lists on the Forms page's Bank-application card (Antonio 2026-11-02:
 * "the settings must be under Forms, in the BofA card"):
 *
 *   bofa_submit_to   where a REVIEWED application is submitted          (default sekureye22@gmail.com)
 *   bofa_notify_to   who is told that an application has arrived         (default support@tonydurante.us)
 *
 * Two ordinary app_settings rows, value = { emails, changed_by, changed_at } so the history of the last change travels
 * with the value. Nothing else is configurable here on purpose (the shipping address comes from lib/td-address.ts).
 *
 * FAILS CLOSED for the one that matters: a missing, empty or unreadable submit-to list means Submit refuses to send
 * (an application is never emailed to an address nobody can see on screen). The notify list falls back to our own
 * support mailbox: a notice to ourselves can never expose an applicant, and silence would hide a new application.
 * Read on every use, no cache. Server-only (supabaseAdmin); the pure parts are tested without a database.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { parseRecipients } from "./recipients"

export const SUBMIT_TO_KEY = "bofa_submit_to"
export const NOTIFY_TO_KEY = "bofa_notify_to"
export const DEFAULT_NOTIFY_TO: readonly string[] = ["support@tonydurante.us"]

export interface AddressSetting {
  emails: string[]
  changedBy: string | null
  changedAt: string | null
}

/** PURE: a stored value → the setting, or null when it is missing / empty / not shaped as expected. */
export function parseAddressSetting(value: unknown): AddressSetting | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  const parsed = parseRecipients(v.emails)
  if ("error" in parsed || parsed.emails.length === 0) return null
  return {
    emails: parsed.emails,
    changedBy: typeof v.changed_by === "string" ? v.changed_by : null,
    changedAt: typeof v.changed_at === "string" ? v.changed_at : null,
  }
}

/** PURE: do these two lists name exactly the same addresses (order and letter case do not matter)? */
export function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  const norm = (l: readonly string[]) => Array.from(new Set(l.map((e) => e.trim().toLowerCase()).filter(Boolean))).sort()
  const x = norm(a)
  const y = norm(b)
  return x.length === y.length && x.every((e, i) => e === y[i])
}

export interface BofaSettings {
  /** null = not set or unreadable: Submit must refuse. */
  submitTo: AddressSetting | null
  /** Always at least one address (falls back to support@). */
  notifyTo: string[]
  notifyToSetting: AddressSetting | null
  /** false when the settings could not be read at all. */
  readable: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- app_settings.value is jsonb
const settingsTable = () => (supabaseAdmin as any).from("app_settings")

export async function loadBofaSettings(): Promise<BofaSettings> {
  const { data, error } = await settingsTable().select("key, value").in("key", [SUBMIT_TO_KEY, NOTIFY_TO_KEY])
  if (error) return { submitTo: null, notifyTo: [...DEFAULT_NOTIFY_TO], notifyToSetting: null, readable: false }
  const byKey = new Map<string, unknown>((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]))
  const notifyToSetting = parseAddressSetting(byKey.get(NOTIFY_TO_KEY))
  return {
    submitTo: parseAddressSetting(byKey.get(SUBMIT_TO_KEY)),
    notifyTo: notifyToSetting ? notifyToSetting.emails : [...DEFAULT_NOTIFY_TO],
    notifyToSetting,
    readable: true,
  }
}

export type SaveSettingsInput = { submitTo: unknown; notifyTo: unknown; by: string }
export type SaveSettingsResult =
  | { ok: true; submitTo: AddressSetting; notifyTo: AddressSetting; changed: { submitTo: boolean; notifyTo: boolean }; before: { submitTo: string[]; notifyTo: string[] } }
  | { ok: false; error: string }

/** Validate both lists, then store them with who/when. Both must name at least one address. */
export async function saveBofaSettings(input: SaveSettingsInput): Promise<SaveSettingsResult> {
  const submit = parseRecipients(input.submitTo)
  if ("error" in submit) return { ok: false, error: submit.error }
  if (submit.emails.length === 0) return { ok: false, error: "Type the address applications are submitted to." }
  const notify = parseRecipients(input.notifyTo)
  if ("error" in notify) return { ok: false, error: notify.error }
  if (notify.emails.length === 0) return { ok: false, error: "Type who should be told when an application arrives." }

  const before = await loadBofaSettings()
  if (!before.readable) return { ok: false, error: "Could not read the current settings. Nothing was changed." }

  const at = new Date().toISOString()
  const value = (emails: string[]) => ({ emails, changed_by: input.by, changed_at: at })
  const { error } = await settingsTable().upsert(
    [
      { key: SUBMIT_TO_KEY, value: value(submit.emails), updated_at: at },
      { key: NOTIFY_TO_KEY, value: value(notify.emails), updated_at: at },
    ],
    { onConflict: "key" },
  )
  if (error) return { ok: false, error: "Could not save the settings. Please try again." }

  const beforeSubmit = before.submitTo?.emails ?? []
  const beforeNotify = before.notifyToSetting?.emails ?? []
  return {
    ok: true,
    submitTo: { emails: submit.emails, changedBy: input.by, changedAt: at },
    notifyTo: { emails: notify.emails, changedBy: input.by, changedAt: at },
    changed: { submitTo: !sameAddresses(beforeSubmit, submit.emails), notifyTo: !sameAddresses(beforeNotify, notify.emails) },
    before: { submitTo: beforeSubmit, notifyTo: beforeNotify },
  }
}
