/**
 * Who may use the TD Storage Mac app (Antonio, 2026-10-17: "ok" to "Antonio and Luca only"). A SETTING, not code: the row
 * `app_settings.storage_app_allowed_emails` = a JSON array of login emails. FAILS CLOSED: a missing, empty or malformed row means
 * nobody can approve a Mac or keep using one. It is read on every request (no cache), so removing someone cuts their Macs at once.
 * This is IN ADDITION to the CRM's own rules (staff role, not suspended, two-step login) — never instead of them.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export const ALLOWED_EMAILS_KEY = "storage_app_allowed_emails"

/** PURE: a settings value → the lower-cased emails in it (anything that is not a list of strings gives an empty list). */
export function parseAllowList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()).filter((v) => v.includes("@"))
}

/** PURE */
export function isOnAllowList(email: string | null | undefined, list: string[]): boolean {
  const e = (email ?? "").trim().toLowerCase()
  return !!e && list.includes(e)
}

export async function loadAllowList(): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- app_settings value is jsonb
  const { data, error } = await (supabaseAdmin as any).from("app_settings").select("value").eq("key", ALLOWED_EMAILS_KEY).maybeSingle()
  if (error) return []                        // cannot read it → nobody (fail closed)
  return parseAllowList(data?.value)
}
