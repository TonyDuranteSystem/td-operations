/**
 * Reads the stored (encrypted) Page key for the Graph client (server; TD Marketing, dev job 9aec66fa). Imported lazily by graph.ts so a
 * context without a database (a unit test, a build step) simply falls back to the Vercel setting. Never throws.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readStoredKey, type KeyDb } from "@/lib/marketing/meta-leads/key-store"

const db = () => supabaseAdmin as unknown as KeyDb

/** A FOUND key is remembered for 30 seconds (the cron and webhook call often). "Nothing stored" is never remembered, so a key connected a moment ago is used at once. */
const CACHE_MS = 30_000
let cache: { at: number; pageId: string; value: string } | null = null

export function clearStoredKeyCache(): void { cache = null }

export async function resolveStoredPageKey(pageId?: string | null): Promise<string | null> {
  const id = pageId ?? ""
  if (cache && cache.pageId === id && Date.now() - cache.at < CACHE_MS) return cache.value
  const r = await readStoredKey(db(), process.env.META_APP_SECRET, pageId || null)
  if (!r?.key) return null
  cache = { at: Date.now(), pageId: id, value: r.key }
  return r.key
}

/** Is any key available (stored, or on Vercel)? Used by the cron to say "nothing to do yet". */
export async function anyPageKeyAvailable(pageIds: string[]): Promise<boolean> {
  if (process.env.META_PAGE_ACCESS_TOKEN) return true
  for (const id of pageIds) if (await resolveStoredPageKey(id)) return true
  return false
}
