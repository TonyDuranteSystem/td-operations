/**
 * Services & SD-types catalog accessor.
 *
 * Reads from `catalog_entries` WHERE `catalog_id = 'services'`. Replaces the
 * old hand-written const at `lib/services/catalog.ts`. The DB is the single
 * source of truth — this module is a typed convenience layer on top of the
 * generic catalog framework.
 *
 * `ServiceSlug` and `SDTypeSlug` are hand-maintained string-literal unions
 * that mirror the seeded slugs. They give callers compile-time safety; the
 * unit test asserts the unions match the DB seed so drift is caught early.
 *
 * Spec: sysdoc `ops-2026-05-09-catalog-framework-spec`.
 */

import {
  type CatalogEntry,
  getEntry,
  labelFor,
  listEntries,
} from "@/lib/catalog/framework"

export const SERVICES_CATALOG_ID = "services" as const

// ── Slug unions (hand-maintained, validated by unit test) ─────────────────

/** Slugs of sellable Services (rows tagged `service`). 11 entries. */
export type ServiceSlug =
  | "llc_formation"
  | "onboarding"
  | "tax_return"
  | "itin"
  | "ein"
  | "banking"
  | "cmra"
  | "shipping"
  | "notary"
  | "closure"
  | "consulting"

/**
 * Slugs of operational Service-Delivery tracks (rows tagged `sd`).
 *
 * `annual_renewal_sd` is intentionally NOT included: per the seed it carries
 * tags `["billing_cycle_artifact", "deprecated"]` (no `sd` tag) — it's a
 * historical artifact, not a live SD track.
 */
export type SDTypeSlug =
  | "company_formation"
  | "client_onboarding"
  | "tax_return"
  | "itin"
  | "ein"
  | "banking"
  | "cmra"
  | "closure"
  | "state_annual_report"
  | "state_ra_renewal"

// ── In-memory cache ───────────────────────────────────────────────────────

interface ServicesCache {
  entries: CatalogEntry[]
  loadedAt: number
}

const CACHE_TTL_MS = 60_000

let cache: ServicesCache | null = null
let inFlight: Promise<CatalogEntry[]> | null = null

async function loadEntries(): Promise<CatalogEntry[]> {
  const now = Date.now()
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.entries
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const entries = await listEntries(SERVICES_CATALOG_ID, { includeDeprecated: true })
      cache = { entries, loadedAt: Date.now() }
      return entries
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Force the next call to re-read from DB. Exported for tests and admin tooling. */
export function _resetServicesCache(): void {
  cache = null
  inFlight = null
}

// ── Read accessors ────────────────────────────────────────────────────────

/** Active rows tagged `service` (sellable services). */
export async function getAllServices(): Promise<CatalogEntry[]> {
  const all = await loadEntries()
  return all.filter((e) => e.status === "active" && e.tags.includes("service"))
}

/** Rows tagged `sd` (operational SD tracks). Includes deprecated by default. */
export async function getAllSDTypes(): Promise<CatalogEntry[]> {
  const all = await loadEntries()
  return all.filter((e) => e.tags.includes("sd"))
}

/** Active rows tagged `auto_bundled_with_management`. */
export async function getLLCManagementBundle(): Promise<CatalogEntry[]> {
  const all = await loadEntries()
  return all.filter(
    (e) => e.status === "active" && e.tags.includes("auto_bundled_with_management"),
  )
}

/** Alias kept for spec parity. */
export const servicesAutoBundledWithManagement = getLLCManagementBundle

/** Active rows tagged `sellable`. */
export async function getAllSellableServices(): Promise<CatalogEntry[]> {
  const all = await loadEntries()
  return all.filter((e) => e.status === "active" && e.tags.includes("sellable"))
}

export async function getServiceBySlug(slug: ServiceSlug | string): Promise<CatalogEntry | null> {
  return getEntry(SERVICES_CATALOG_ID, slug)
}

/**
 * SD types are referenced in `service_deliveries.service_type` by display
 * name (e.g. `"Tax Return"`, `"Banking"`), not slug. This helper looks up
 * an SD entry by its display name.
 */
export async function getSDByType(displayName: string): Promise<CatalogEntry | null> {
  const all = await loadEntries()
  return all.find((e) => e.tags.includes("sd") && e.display_name === displayName) ?? null
}

/** True if the SD-type display name corresponds to a row tagged both `sd` and `sellable`. */
export async function isStandaloneSD(sdType: string): Promise<boolean> {
  const entry = await getSDByType(sdType)
  if (!entry) return false
  return entry.tags.includes("sd") && entry.tags.includes("sellable")
}

export async function labelForService(slug: string, lang: string = "en"): Promise<string> {
  const entry = await getEntry(SERVICES_CATALOG_ID, slug)
  if (!entry) return slug
  return labelFor(entry, lang)
}

/** Map of slug → English display_name for every services-catalog row. */
export async function slugToDisplay(): Promise<Record<string, string>> {
  const all = await loadEntries()
  const map: Record<string, string> = {}
  for (const e of all) map[e.slug] = e.display_name
  return map
}

/** Map of English display_name → slug for every services-catalog row. */
export async function displayToSlug(): Promise<Record<string, string>> {
  const all = await loadEntries()
  const map: Record<string, string> = {}
  for (const e of all) map[e.display_name] = e.slug
  return map
}
