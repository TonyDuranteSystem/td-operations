import { supabaseAdmin } from "@/lib/supabase-admin"
import { SUPPORTED_LOCALES } from "@/lib/portal/i18n"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"

/**
 * Load every generated translation for one language from `portal_translations`
 * (dev job 12cab351), as a flat key -> translated_text map — the same shape
 * `t()`'s static dictionary already uses for 'en'/'it', so the caller can
 * merge the two with a plain object spread and keep every existing lookup
 * synchronous. Only 'done' rows are returned: a 'pending'/'generating' row
 * has no usable text yet, and the caller's own fallback-to-English handles
 * that gap exactly the same way a missing key always has.
 *
 * 'en' and every locale in SUPPORTED_LOCALES already have a complete,
 * human-approved static dictionary (lib/portal/i18n.ts) — short-circuits to
 * an empty map without a database round trip, since there is nothing this
 * table could add for those two languages yet (nothing has been migrated
 * into it — that's a later milestone of the same job).
 *
 * PAGINATED (found 2026-08-22, same class of bug as the bank_transactions
 * 1000-row incident this reuses the fix for): PostgREST caps a single
 * select() at 1000 rows. The proof-of-concept locale used to verify this
 * whole project already carries over 1000 'done' rows, so an unpaginated
 * query was silently dropping whichever keys landed past the cutoff — those
 * keys fell back to English with no error, no log, nothing to notice. Reuses
 * fetchAllPaged (lib/bank-transactions-fetch.ts) rather than a second
 * hand-rolled loop; `id` is the unique tiebreaker required for range-based
 * pagination to never skip or duplicate a row.
 *
 * Called once by the layout and, separately, by any Server Component page
 * that also needs `translations` (it cannot receive the layout's copy —
 * layouts and pages are independent Server Components in the App Router).
 * Not memoized across those two calls: this project is on React 18, which
 * doesn't have React.cache() for per-request dedup. Acceptable duplication
 * today since this short-circuits to {} instantly for 'en'/'it' — the only
 * languages actually selectable yet; revisit if/when a third language is
 * live and this becomes a real second query per request.
 */
export async function loadTranslationsForLocale(
  locale: string,
): Promise<Record<string, string>> {
  if ((SUPPORTED_LOCALES as readonly string[]).includes(locale)) return {}

  const rows = await fetchAllPaged<{ key: string; translated_text: string }>(
    async (from, to) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_translations not yet in generated types (regenerated on production promotion)
      const { data, error } = await (supabaseAdmin as any)
        .from("portal_translations")
        .select("key, translated_text")
        .eq("language_code", locale)
        .eq("status", "done")
        .order("id", { ascending: true })
        .range(from, to)
      if (error) return []
      return data ?? []
    },
  )

  const map: Record<string, string> = {}
  for (const row of rows) map[row.key] = row.translated_text
  return map
}
