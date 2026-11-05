/**
 * TD Social — each person's alert switches (pure; dev job 2072bc3e, Step 2 pull request B; Council-reviewed plan of 5 Nov 2026).
 *
 * Only OVERRIDES are stored. A missing key means "use the rule's default", so a new tab or mailbox needs no data change, and the
 * defaults are RULES, never names:
 *   - WhatsApp alerts: ON.
 *   - A mailbox's email alerts: ON only when that mailbox is the person's ONLY mailbox (Luca sees only support@, so he gets it; Antonio and
 *     Jodi, who see two, get none until they switch one on).
 *   - Nothing is muted.
 * A muted tab sends no alert and is not counted in the icon number. The switches are read by the alert sender (pull request C2) and the
 * WhatsApp / email alerts (pull request D); this file only decides and validates them.
 *
 * Storage keys (flat, so the database can merge them key by key): `whatsapp`, `email:<mailbox>`.
 */
import type { AppTab } from "@/lib/app/tabs"

export interface StoredPrefs {
  muted_tabs?: string[] | null
  alerts?: Record<string, unknown> | null
}

export interface EffectivePrefs {
  /** tabs the person muted (only tabs they actually have) */
  mutedTabs: string[]
  /** present only when the person has the WhatsApp tab */
  whatsapp?: boolean
  /** present only when the person has the Inbox tab: one switch per mailbox they may open */
  email?: Record<string, boolean>
}

export const MAX_PREF_KEYS = 20

const isBool = (v: unknown): v is boolean => typeof v === "boolean"

export function emailKey(mailbox: string): string {
  return `email:${mailbox}`
}

/** What the switches are right now: the stored overrides over the rule defaults, limited to what this person can see. */
export function effectivePrefs(tabs: readonly AppTab[], stored: StoredPrefs | null | undefined): EffectivePrefs {
  const have = new Set<string>(tabs.map(t => t.id))
  const alerts = stored?.alerts && typeof stored.alerts === "object" ? stored.alerts : {}
  const out: EffectivePrefs = {
    mutedTabs: Array.from(new Set((stored?.muted_tabs ?? []).filter(t => have.has(t)))).sort(),
  }
  if (have.has("whatsapp")) out.whatsapp = isBool(alerts.whatsapp) ? alerts.whatsapp : true
  const inbox = tabs.find(t => t.id === "inbox")
  if (inbox?.mailboxes) {
    const only = inbox.mailboxes.length === 1
    out.email = {}
    for (const m of inbox.mailboxes) {
      const v = alerts[emailKey(m)]
      out.email[m] = isBool(v) ? v : only
    }
  }
  return out
}

export interface PrefsPatch {
  /** tab -> true (mute) / false (unmute); tabs not named are left alone */
  mute: Record<string, boolean>
  /** storage key -> on / off */
  alerts: Record<string, boolean>
}

export type PatchResult = { ok: true; value: PrefsPatch } | { ok: false; code: string; error: string }

const bad = (code: string, error: string): { ok: false; code: string; error: string } => ({ ok: false, code, error })

/**
 * Check a request to change switches. Everything must be a real boolean for something THIS person has: a tab they do not have, a mailbox they
 * may not open, an unknown key or a non-boolean is refused (a typo must not silently do nothing, and a switch must not exist for a thing the
 * person cannot see).
 */
export function parsePrefsPatch(body: unknown, tabs: readonly AppTab[]): PatchResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("BAD_BODY", "Send a JSON object.")
  const b = body as Record<string, unknown>
  for (const k of Object.keys(b)) if (k !== "mute" && k !== "alerts") return bad("BAD_KEY", `Unknown field: ${k.slice(0, 40)}.`)
  const have = new Set<string>(tabs.map(t => t.id))
  const inbox = tabs.find(t => t.id === "inbox")
  const allowedAlertKeys = new Set<string>()
  if (have.has("whatsapp")) allowedAlertKeys.add("whatsapp")
  for (const m of inbox?.mailboxes ?? []) allowedAlertKeys.add(emailKey(m))

  const mute: Record<string, boolean> = {}
  const alerts: Record<string, boolean> = {}
  for (const [name, section, allowed, label] of [
    ["mute", mute, have as ReadonlySet<string>, "tab"],
    ["alerts", alerts, allowedAlertKeys as ReadonlySet<string>, "alert switch"],
  ] as const) {
    const raw = b[name]
    if (raw === undefined) continue
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("BAD_BODY", `${name} must be an object.`)
    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length > MAX_PREF_KEYS) return bad("TOO_MANY", "Too many switches in one request.")
    for (const [k, v] of entries) {
      if (!allowed.has(k)) return bad("NOT_ALLOWED", `You do not have this ${label}: ${k.slice(0, 40)}.`)
      if (!isBool(v)) return bad("BAD_VALUE", `${k.slice(0, 40)} must be true or false.`)
      section[k] = v
    }
  }
  if (Object.keys(mute).length === 0 && Object.keys(alerts).length === 0) return bad("EMPTY", "Nothing to change.")
  return { ok: true, value: { mute, alerts } }
}
