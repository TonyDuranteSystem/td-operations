import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Global ceiling on how many DISTINCT languages can start real AI-translation
 * work in a rolling 24h window (dev job 12cab351). Protects the flat, bounded
 * per-language cost (~$1-2 to fully translate one language, per the council's
 * sizing) from becoming an UNbounded one if many different rare languages get
 * requested in a short window. Deliberately a plain constant, not settings-table
 * config — small enough surface area that a code change + deploy is fine, and
 * it keeps this file free of any runtime dependency. Adjust the number here.
 */
export const MAX_NEW_LANGUAGES_PER_DAY = 8

const WINDOW_MS = 24 * 60 * 60 * 1000
/** Upper bound on rows scanned for the distinct-language count — a single day's
 *  translation activity across all languages fits comfortably under this; if a
 *  future language's dictionary genuinely exceeds it, undercounting the window
 *  only makes the cap MORE permissive, never a false block. */
const SCAN_LIMIT = 5000

/**
 * How many distinct languages have had ANY translation row created in the
 * last 24h — a deliberately simple, slightly conservative proxy for "how many
 * new languages started today" (a language merely topping up a few new keys
 * also counts, which only makes this cap MORE cautious, never less).
 */
export async function distinctLanguagesTranslatedToday(): Promise<number> {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
  const { data } = await (supabaseAdmin as any)
    .from("portal_translations")
    .select("language_code")
    .gte("created_at", cutoff)
    .limit(SCAN_LIMIT)
  const codes = new Set<string>((data ?? []).map((r: { language_code: string }) => r.language_code))
  return codes.size
}

/** True when this specific language has never had a single row before —
 *  the only case the daily cap needs to gate (topping up an existing
 *  language's missing keys is not a "new" language and never blocked). */
export async function isBrandNewLanguage(languageCode: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
  const { count } = await (supabaseAdmin as any)
    .from("portal_translations")
    .select("id", { count: "exact", head: true })
    .eq("language_code", languageCode)
  return (count ?? 0) === 0
}
