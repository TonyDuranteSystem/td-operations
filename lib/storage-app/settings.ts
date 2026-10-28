/**
 * ONE flexible settings row for the TD Storage Mac app (dev job 1992a087, production rollout preparation): `app_settings.storage_app_settings`
 * (JSON). Read on every request like the allow-list, so a change takes effect at once with no deploy. Every field is optional: a missing,
 * malformed or out-of-range field falls back to its DEFAULT (field by field — one bad value never spoils the others), and the defaults are the
 * SAFE ones: client-folder saves OFF, a verified second login step REQUIRED. The security timers (token lifetimes, PKCE, the 60-second links,
 * the refresh grace) are deliberately NOT settings: they are not meant to be changed casually.
 *
 * Example value:
 *   { "clientSaves": { "owners": ["<store owner id | account id | contact id>", …] | "all", "ownerKinds": ["company","person"], "folderKinds": ["custom","correspondence"] },
 *     "keepSecondsSensitive": 120, "keepSecondsNormal": 900, "maxSaveMB": 2048, "readLimitMB": 2048, "writeLimitMB": 5120,
 *     "leaseHours": 24, "maxMacsPerLogin": 5, "resyncMinutes": 10, "updateCheckMinutes": 60, "updateHintSeconds": 60, "requireSecondFactor": true, "sensitiveTypes": ["passport", …] }
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { LEASE_MS, MAX_ACTIVE_DEVICES_PER_USER } from "./tokens"

export const SETTINGS_KEY = "storage_app_settings"

export interface ClientSaves { owners: string[] | "all"; ownerKinds: string[]; folderKinds: string[] }
export interface StorageAppSettings {
  clientSaves: ClientSaves
  keepSecondsSensitive: number
  keepSecondsNormal: number
  maxSaveMB: number
  readLimitMB: number
  writeLimitMB: number
  leaseHours: number
  maxMacsPerLogin: number
  resyncMinutes: number
  updateCheckMinutes: number
  updateHintSeconds: number
  pushWaitSeconds: number
  requireSecondFactor: boolean
  sensitiveTypes: string[]
}

export const DEFAULT_SENSITIVE_TYPES: readonly string[] = [
  "passport", "id_document", "itin_letter", "form_w_7", "form_w_7_coa", "form_1040_nr", "itin_application", "itin_schedule_oi",
]

/** The biggest NEW file a Mac may save, whatever the setting says (2026-10-27, Antonio: Zoom recordings of ~1 GB). Anything over the writer's inline cap (150 MB)
 *  is registered by a background job while the Mac waits (see saveFromSlot); updating a file that is already saved stays at the inline cap. */
export const ABSOLUTE_MAX_SAVE_MB = 2048

/** The longest a change question may stay open (seconds). Kept well under the function time limit. */
export const PUSH_WAIT_MAX_SECONDS = 20

export function defaultSettings(env: Record<string, string | undefined> = process.env): StorageAppSettings {
  const mb = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
  return {
    clientSaves: { owners: [], ownerKinds: ["company", "person"], folderKinds: ["custom", "correspondence"] },   // OFF until named
    keepSecondsSensitive: 120,
    keepSecondsNormal: 900,
    maxSaveMB: ABSOLUTE_MAX_SAVE_MB,
    readLimitMB: mb(env.STORAGE_APP_READ_LIMIT_MB, 2048),
    writeLimitMB: mb(env.STORAGE_APP_WRITE_LIMIT_MB, 5120),
    leaseHours: LEASE_MS / 3_600_000,
    maxMacsPerLogin: MAX_ACTIVE_DEVICES_PER_USER,
    resyncMinutes: 10,
    updateCheckMinutes: 60,
    updateHintSeconds: 60,
    pushWaitSeconds: PUSH_WAIT_MAX_SECONDS,
    requireSecondFactor: true,
    sensitiveTypes: [...DEFAULT_SENSITIVE_TYPES],
  }
}

const num = (v: unknown, min: number, max: number, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d)
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "") ? v.map((x) => (x as string).trim()) : null)

/** PURE. Field by field; anything wrong → that field's default. `clientSaves` fails CLOSED (nobody). */
export function parseSettings(raw: unknown, env: Record<string, string | undefined> = process.env): StorageAppSettings {
  const d = defaultSettings(env)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d
  const r = raw as Record<string, unknown>
  let clientSaves = d.clientSaves
  if (r.clientSaves && typeof r.clientSaves === "object" && !Array.isArray(r.clientSaves)) {
    const c = r.clientSaves as Record<string, unknown>
    const owners = c.owners === "all" ? "all" : strList(c.owners) ?? []                    // missing / malformed → nobody
    clientSaves = { owners, ownerKinds: strList(c.ownerKinds) ?? d.clientSaves.ownerKinds, folderKinds: strList(c.folderKinds) ?? d.clientSaves.folderKinds }
  }
  return {
    clientSaves,
    keepSecondsSensitive: num(r.keepSecondsSensitive, 10, 86_400, d.keepSecondsSensitive),
    keepSecondsNormal: num(r.keepSecondsNormal, 10, 86_400, d.keepSecondsNormal),
    maxSaveMB: num(r.maxSaveMB, 1, ABSOLUTE_MAX_SAVE_MB, d.maxSaveMB),
    readLimitMB: num(r.readLimitMB, 10, 1_000_000, d.readLimitMB),
    writeLimitMB: num(r.writeLimitMB, 10, 1_000_000, d.writeLimitMB),
    leaseHours: num(r.leaseHours, 1, 720, d.leaseHours),
    maxMacsPerLogin: Math.round(num(r.maxMacsPerLogin, 1, 20, d.maxMacsPerLogin)),
    resyncMinutes: num(r.resyncMinutes, 1, 1440, d.resyncMinutes),
    pushWaitSeconds: num(r.pushWaitSeconds, 0, PUSH_WAIT_MAX_SECONDS, d.pushWaitSeconds),   // how long a Mac's "tell me when something changes" question may stay open (0 = off: the Mac falls back to asking once a minute)
    updateHintSeconds: num(r.updateHintSeconds, 30, 3600, d.updateHintSeconds),   // how often a Mac asks the CRM "who am I / is a newer build offered?" (the app follows it; 30 s .. 1 h)
    updateCheckMinutes: num(r.updateCheckMinutes, 60, 1440, d.updateCheckMinutes),   // how often a Mac looks for a new app version (never below an hour)
    requireSecondFactor: typeof r.requireSecondFactor === "boolean" ? r.requireSecondFactor : d.requireSecondFactor,
    sensitiveTypes: strList(r.sensitiveTypes) ?? d.sensitiveTypes,
  }
}

/** PURE: may a Mac save into a CLIENT storage of this kind / this owner? (owners: a list matched against the store owner id, the account id or the contact id — or "all"). */
export function clientSaveAllowed(cs: ClientSaves, o: { kind: string | null | undefined; ownerId?: string | null; accountId?: string | null; contactId?: string | null }): boolean {
  if (!o.kind || !cs.ownerKinds.includes(o.kind)) return false
  if (cs.owners === "all") return true
  return [o.ownerId, o.accountId, o.contactId].some((id) => !!id && (cs.owners as string[]).includes(id))
}

/** Read the row. A read error → the defaults (so client saves are OFF and the second step is required: fail closed). */
export async function getSettings(): Promise<StorageAppSettings> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- app_settings value is jsonb
    const { data, error } = await (supabaseAdmin as any).from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle()
    if (error) return defaultSettings()
    return parseSettings(data?.value)
  } catch { return defaultSettings() }
}
