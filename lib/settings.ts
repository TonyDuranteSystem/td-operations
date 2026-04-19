/**
 * Server-side reader/writer for the `app_settings` table (key/jsonb/updated_at).
 *
 * Used for feature flags and other runtime-toggleable values that ops wants
 * to change without a code deploy. First real consumer: `tax_season_paused`
 * for the 2026 tax season suspension — when true, the client-facing tax
 * data-collection banner and wizard are gated off, and new Tax Return SDs
 * are auto-parked at `on_hold` at intake time instead of `active`.
 *
 * Keep this file server-only (it uses supabaseAdmin). Do not import it
 * into a client component.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** Known keys. Adding a new flag? Document it here, default behavior, and
 *  where it's consumed. */
export type AppSettingKey =
  | "tax_season_paused" // boolean — when true, Tax Return banner + wizard + intake are gated.

export async function getAppSetting<T = unknown>(
  key: AppSettingKey,
  fallback: T,
): Promise<T> {
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle()
  if (error || !data) return fallback
  return (data.value as unknown as T) ?? fallback
}

export async function setAppSetting(
  key: AppSettingKey,
  value: unknown,
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- app_settings is not a protected table; direct upsert is appropriate
  const { error } = await supabaseAdmin
    .from("app_settings")
    .upsert({ key, value: value as never, updated_at: new Date().toISOString() }, { onConflict: "key" })
  if (error) throw new Error(`setAppSetting(${key}) failed: ${error.message}`)
}

/** Narrow helper for the tax-season flag. Returns false (season open) by
 *  default if the row is missing or the cast fails. */
export async function isTaxSeasonPaused(): Promise<boolean> {
  const v = await getAppSetting<boolean>("tax_season_paused", false)
  return v === true
}
