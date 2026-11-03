/**
 * Bank application intake — the two address lists (Antonio 2026-11-02; 2026-11-03: NO email address is shown or edited on any
 * form card, so there is no screen for these — a developer changes the stored value):
 *
 *   bofa_submit_to   where a REVIEWED application is submitted          (default sekureye22@gmail.com)
 *   bofa_notify_to   who is told that an application has arrived         (default support@tonydurante.us)
 *
 * Two ordinary app_settings rows, value = { emails, changed_by, changed_at }. Read-only from the CRM: nothing writes them
 * except a migration or a developer (the shipping address comes from lib/td-address.ts).
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
