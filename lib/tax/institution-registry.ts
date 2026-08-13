/**
 * The LIVE institution registry — catalog-backed, seed-fallback.
 *
 * Identity build step 1 (card 4a39e0fd queue; Antonio's ruling 2026-08-13:
 * "the institution list must be flexible" — staff add or reclassify an
 * institution from /catalog without a deploy). The reviewed in-code seed
 * (lib/tax/bank-identity.ts INSTITUTION_SEED) stays as the baseline and the
 * fallback; catalog rows (catalog_entries 'bank_export_guides', status=active)
 * MERGE OVER it by canonical name — a catalog row wins over the seed's entry,
 * and seed entries with no catalog row survive, so deleting a catalog row can
 * never silently un-know a reviewed institution.
 *
 * Row contract (metadata):
 *   identity_mode: 'account_number' | 'currency' | 'crypto'  (absent → account_number,
 *     the conservative default: assume a bank, ask for the number)
 *   match_terms:   string[] — UNAMBIGUOUS full-name aliases (exact-normalized
 *     match, never substring/fuzzy). The display_name always counts as a term.
 *
 * Cached in-process for 60s: identity resolution runs per uploaded file and per
 * financials rebuild; per-call catalog reads would be waste. Never throws — on
 * any error the seed serves alone.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { INSTITUTION_SEED, type InstitutionEntry, type IdentityMode } from "./bank-identity"

const CACHE_MS = 60_000
let cache: { at: number; registry: InstitutionEntry[] } | null = null

const VALID_MODES: ReadonlySet<string> = new Set(["account_number", "currency", "crypto"])

interface CatalogRow {
  display_name: string | null
  metadata: { identity_mode?: string; match_terms?: unknown } | null
}

/** Pure merge — exported for tests. Catalog rows win by canonical name. */
export function mergeRegistry(seed: InstitutionEntry[], rows: CatalogRow[]): InstitutionEntry[] {
  const byCanonical = new Map<string, InstitutionEntry>()
  for (const e of seed) byCanonical.set(e.canonical.toLowerCase(), e)
  for (const r of rows) {
    const canonical = (r.display_name ?? "").trim()
    if (!canonical) continue
    const meta = r.metadata ?? {}
    const mode: IdentityMode = VALID_MODES.has(String(meta.identity_mode))
      ? (meta.identity_mode as IdentityMode)
      : "account_number"
    const terms = Array.isArray(meta.match_terms)
      ? meta.match_terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : []
    // The display name itself always matches — a staff-added institution with
    // no aliases yet must still resolve by its own name.
    if (!terms.some(t => t.toLowerCase() === canonical.toLowerCase())) terms.push(canonical)
    byCanonical.set(canonical.toLowerCase(), { canonical, mode, matchTerms: terms })
  }
  return Array.from(byCanonical.values())
}

/**
 * Load the merged registry. Cached 60s; seed-only on any failure.
 * Call sites pass the result as the `registry` argument of
 * resolveInstitution / canonicalBankName / buildAccountRef / accountKeyOf.
 */
export async function loadInstitutionRegistry(): Promise<InstitutionEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.registry
  try {
    const { data, error } = await supabaseAdmin
      .from("catalog_entries")
      .select("display_name, metadata")
      .eq("catalog_id", "bank_export_guides")
      .eq("status", "active")
    if (error) throw new Error(error.message)
    const registry = mergeRegistry(INSTITUTION_SEED, (data ?? []) as CatalogRow[])
    cache = { at: Date.now(), registry }
    return registry
  } catch (e) {
    console.error("[institution-registry] catalog read failed — serving the code seed:", e)
    return INSTITUTION_SEED
  }
}

/** Test hook: drop the cache. */
export function __clearRegistryCache(): void {
  cache = null
}
