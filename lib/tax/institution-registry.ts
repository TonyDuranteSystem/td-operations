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

/** Pure merge — exported for tests. Catalog rows win by canonical name, with
 *  two SAFETY rules the bug-hunter forced (2026-08-13, pre-migration hazard):
 *  1. A catalog row with NO/invalid identity_mode NEVER overrides the seed's
 *     reviewed mode — before the identity migration runs, production catalog
 *     rows are mode-less, and letting them default to account_number would
 *     DEMAND a number from every Wise/Revolut/Airwallex client. Mode falls
 *     back: catalog (valid) → seed's entry → account_number (unknown inst.).
 *  2. match_terms UNION with the seed's aliases, never replace — the prod
 *     chase row carries 3 terms vs the seed's 11; replacement would silently
 *     un-know "JPMorgan Chase Bank, N.A." and resurrect the name-drift split
 *     this build exists to heal. */
export function mergeRegistry(seed: InstitutionEntry[], rows: CatalogRow[]): InstitutionEntry[] {
  const byCanonical = new Map<string, InstitutionEntry>()
  for (const e of seed) byCanonical.set(e.canonical.toLowerCase(), e)
  for (const r of rows) {
    const canonical = (r.display_name ?? "").trim()
    if (!canonical) continue
    const seedEntry = byCanonical.get(canonical.toLowerCase())
    const meta = r.metadata ?? {}
    const mode: IdentityMode = VALID_MODES.has(String(meta.identity_mode))
      ? (meta.identity_mode as IdentityMode)
      : seedEntry?.mode ?? "account_number"
    const catalogTerms = Array.isArray(meta.match_terms)
      ? meta.match_terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : []
    // UNION (case-insensitive) of catalog + seed aliases + the display name —
    // a staff-added alias adds; nothing ever silently un-knows a reviewed one.
    const seen = new Set<string>()
    const terms: string[] = []
    for (const t of [...catalogTerms, ...(seedEntry?.matchTerms ?? []), canonical]) {
      const k = t.toLowerCase()
      if (!seen.has(k)) { seen.add(k); terms.push(t) }
    }
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
