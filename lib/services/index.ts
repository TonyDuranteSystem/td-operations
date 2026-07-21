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

/**
 * Display names of the 4 LLC Management bundle SD types — the value written to
 * `annual_agreements.bundled_pipelines` and `offers.bundled_pipelines`.
 *
 * Order is the historical write order (CMRA, State RA Renewal, State Annual
 * Report, Tax Return) — preserved so callers produce byte-identical JSONB to
 * what's already in the DB. The bundle's *set* membership is derived from the
 * catalog (`auto_bundled_with_management` tag); a unit test asserts the set
 * here matches the catalog so drift between the two is caught at build time.
 */
export const LLC_MANAGEMENT_BUNDLE_TYPES: readonly string[] = [
  "CMRA Mailing Address",
  "State RA Renewal",
  "State Annual Report",
  "Tax Return",
] as const

/**
 * Async accessor — returns the bundle SD-type display names. Reads through
 * the catalog cache and respects the `auto_bundled_with_management` tag, but
 * yields entries in catalog seed order (NOT the historical write order). For
 * writes to `bundled_pipelines`, prefer `LLC_MANAGEMENT_BUNDLE_TYPES` so the
 * stored array stays consistent with existing rows.
 */
export async function getLLCManagementBundleTypes(): Promise<string[]> {
  const entries = await getLLCManagementBundle()
  return entries.map((e) => e.display_name)
}

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

/**
 * Authoritative `service_deliveries.service_type` → catalog slug map.
 *
 * Mirrors §1 of `scripts/migrations/20260510-catalog-backfill.sql` so that
 * SDs created at runtime resolve to the same catalog entry the Phase 2
 * backfill assigned to historical rows. Any change here MUST be applied to
 * the migration in the same PR (or vice versa).
 *
 * Values not in this map intentionally return `null` — callers (currently
 * only `lib/operations/service-delivery.ts::createSD`) treat that as a
 * warning, not an error, so legitimate but unmapped service types
 * (`Support`, `Client Offboarding`, etc.) still produce SDs.
 */
const SERVICE_TYPE_TO_SLUG: Record<string, string> = {
  "State Annual Report": "state_annual_report",
  "CMRA Mailing Address": "cmra",
  "State RA Renewal": "state_ra_renewal",
  "Tax Return": "tax_return",
  "Tax Return One-Time": "tax_return_one_time",
  "Company Formation": "company_formation",
  "Annual Renewal": "annual_renewal_sd",
  EIN: "ein",
  ITIN: "itin",
  "Banking Fintech": "banking",
  "Banking Physical": "banking_physical",
  "Client Onboarding": "client_onboarding",
  "Company Closure": "closure",
  DBA: "dba",
}

/**
 * Map a `service_deliveries.service_type` TEXT value (e.g. `"EIN"`,
 * `"Banking Fintech"`, `"CMRA Mailing Address"`) to its catalog entry.
 *
 * Used by `createSD` to populate `service_type_entry_id` on insert. Returns
 * `null` for values not in `SERVICE_TYPE_TO_SLUG` — caller decides whether
 * to log/skip/error (today: warn-and-skip).
 */
export async function getEntryByServiceType(
  serviceType: string,
): Promise<CatalogEntry | null> {
  const slug = SERVICE_TYPE_TO_SLUG[serviceType]
  if (!slug) return null
  const all = await loadEntries()
  return all.find((e) => e.slug === slug) ?? null
}

/**
 * Pipeline / `service_type` names tagged `start_at_wizard` — personal services
 * (e.g. ITIN) whose SD is created at formation/onboarding WIZARD SUBMIT, in
 * parallel, instead of being deferred to company creation. Returned as the
 * `service_type` names used in `offers.bundled_pipelines` (e.g. "ITIN").
 *
 * Data-driven so adding another start-at-wizard personal service needs only a
 * catalog tag, not a code change. See dev_task fcf5e254 + the
 * 20260521-1605-itin-start-at-wizard-tag migration.
 */
export async function getStartAtWizardServiceTypes(): Promise<string[]> {
  const all = await loadEntries()
  const slugs = new Set(
    all
      .filter((e) => e.status === "active" && e.tags.includes("start_at_wizard"))
      .map((e) => e.slug),
  )
  return Object.entries(SERVICE_TYPE_TO_SLUG)
    .filter(([, slug]) => slugs.has(slug))
    .map(([serviceType]) => serviceType)
}

/**
 * Pipeline / `service_type` names tagged `per_person` — services a single
 * PERSON can only ever hold ONE live instance of, because the real-world thing
 * being delivered is unique to that person. ITIN is the canonical case:
 * a person receives exactly one ITIN in their life and cannot apply for a
 * second (Antonio, 2026-07-20).
 *
 * Why this is a catalog tag and not an `if (serviceType === "ITIN")`: an offer
 * line of "ITIN ×2" means two ITINs for two DIFFERENT PEOPLE, never two for one
 * person — so any code that multiplies units onto a single contact is wrong by
 * construction for these services. Tagging makes that a property of the
 * service, so the next per-person service (ITIN Renewal, an individual return)
 * inherits the protection instead of reproducing the bug from scratch.
 *
 * Enforced in three places: this tag (business layer), the per-person guard in
 * lib/operations/itin-from-wizard.ts, and the DB partial unique index
 * uq_itin_sd_active_per_contact (race backstop).
 */
export async function getPerPersonServiceTypes(): Promise<string[]> {
  const all = await loadEntries()
  const slugs = new Set(
    all
      .filter((e) => e.status === "active" && e.tags.includes("per_person"))
      .map((e) => e.slug),
  )
  return Object.entries(SERVICE_TYPE_TO_SLUG)
    .filter(([, slug]) => slugs.has(slug))
    .map(([serviceType]) => serviceType)
}

/** True when a single person can hold at most ONE live instance of this service. */
export async function isPerPersonServiceType(serviceType: string): Promise<boolean> {
  return (await getPerPersonServiceTypes()).includes(serviceType)
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

// ── Static mirror (sync access for client components) ─────────────────────

export interface StaticServiceEntry {
  slug: string
  display_name: string
  display_name_translations: Record<string, string>
  status: "active" | "deprecated" | "exception_only"
  tags: readonly string[]
}

/**
 * Hand-maintained mirror of the 18 production seed rows for
 * `catalog_id='services'`. Synchronously available, suitable for use in
 * client components that cannot `await`.
 *
 * Drift between this list and the DB seed is caught at build time by a unit
 * test in `tests/unit/catalog-framework.test.ts`. Any change to the
 * canonical seed must be reflected here in the same PR.
 */
export const SERVICES_STATIC: readonly StaticServiceEntry[] = [
  {
    slug: "llc_formation",
    display_name: "LLC Formation",
    display_name_translations: { it: "Costituzione LLC" },
    status: "active",
    tags: ["service", "sellable", "entry_to_management"],
  },
  {
    slug: "onboarding",
    display_name: "Onboarding",
    display_name_translations: { it: "Onboarding LLC esistente" },
    status: "active",
    tags: ["service", "sellable", "entry_to_management"],
  },
  {
    slug: "tax_return",
    display_name: "Tax Return",
    display_name_translations: { it: "Dichiarazione Fiscale" },
    status: "active",
    tags: ["service", "sd", "sellable", "auto_bundled_with_management"],
  },
  {
    slug: "itin",
    display_name: "ITIN Application",
    display_name_translations: { it: "Richiesta ITIN" },
    status: "active",
    tags: ["service", "sd", "sellable"],
  },
  {
    slug: "ein",
    display_name: "EIN Application",
    display_name_translations: { it: "Richiesta EIN" },
    status: "active",
    tags: ["service", "sd", "sellable"],
  },
  {
    slug: "banking",
    display_name: "Banking",
    display_name_translations: { it: "Apertura conto bancario" },
    status: "active",
    tags: ["service", "sd", "sellable"],
  },
  {
    slug: "cmra",
    display_name: "CMRA Mailing Address",
    display_name_translations: { it: "Indirizzo postale (CMRA)" },
    status: "active",
    tags: ["service", "sd", "sellable", "auto_bundled_with_management"],
  },
  {
    slug: "shipping",
    display_name: "Shipping Service",
    display_name_translations: {},
    status: "active",
    tags: ["service", "sellable"],
  },
  {
    slug: "notary",
    display_name: "Public Notary",
    display_name_translations: {},
    status: "active",
    tags: ["service", "sellable"],
  },
  {
    slug: "closure",
    display_name: "Company Closure",
    display_name_translations: {},
    status: "active",
    tags: ["service", "sd", "sellable"],
  },
  {
    slug: "consulting",
    display_name: "Consulting Call",
    display_name_translations: {},
    status: "active",
    tags: ["service", "sellable"],
  },
  {
    slug: "state_annual_report",
    display_name: "State Annual Report",
    display_name_translations: { it: "Rapporto annuale statale" },
    status: "active",
    tags: ["sd", "auto_bundled_with_management"],
  },
  {
    slug: "state_ra_renewal",
    display_name: "State RA Renewal",
    display_name_translations: { it: "Rinnovo Registered Agent" },
    status: "active",
    tags: ["sd", "auto_bundled_with_management"],
  },
  {
    slug: "client_onboarding",
    display_name: "Client Onboarding",
    display_name_translations: {},
    status: "active",
    tags: ["sd"],
  },
  {
    slug: "company_formation",
    display_name: "Company Formation",
    display_name_translations: {},
    status: "active",
    tags: ["sd"],
  },
  {
    slug: "annual_renewal_sd",
    display_name: "Annual Renewal (Legacy SD)",
    display_name_translations: {},
    status: "deprecated",
    tags: ["billing_cycle_artifact", "deprecated"],
  },
  {
    slug: "custom",
    display_name: "Custom",
    display_name_translations: {},
    status: "exception_only",
    tags: ["exception"],
  },
  {
    slug: "pending_review",
    display_name: "Pending Review",
    display_name_translations: {},
    status: "exception_only",
    tags: ["exception"],
  },
]

/** Active rows tagged `service`, in seed order. Sync mirror of `getAllServices()`. */
export const SERVICES_STATIC_SELLABLE: readonly StaticServiceEntry[] = SERVICES_STATIC.filter(
  (e) => e.status === "active" && e.tags.includes("service"),
)

/** Active rows tagged `sd`, in seed order. Sync mirror of `getAllSDTypes()`. */
export const SD_STATIC: readonly StaticServiceEntry[] = SERVICES_STATIC.filter(
  (e) => e.status === "active" && e.tags.includes("sd"),
)

/** Sync slug→entry lookup keyed by canonical catalog slug. */
const STATIC_BY_SLUG: Record<string, StaticServiceEntry> = Object.fromEntries(
  SERVICES_STATIC.map((e) => [e.slug, e]),
)

export function getServiceBySlugStatic(slug: string): StaticServiceEntry | null {
  return STATIC_BY_SLUG[slug] ?? null
}

/** English-or-translated display name for a slug. Sync mirror of `labelForService()`. */
export function labelForServiceStatic(slug: string, lang: string = "en"): string {
  const e = STATIC_BY_SLUG[slug]
  if (!e) return slug
  if (lang !== "en" && e.display_name_translations[lang]) {
    return e.display_name_translations[lang]
  }
  return e.display_name
}
