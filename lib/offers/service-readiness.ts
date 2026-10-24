/**
 * Is every NEW service on an offer ready to be sold? (flexible-offer track, Step 0)
 *
 * A service created in the Service Catalog screen can be put on an offer the
 * moment it is saved — before anyone has given it any steps, or after someone
 * switched it off. Such an offer used to be sent happily; the client paid and
 * nothing started (the delivery cannot be created without steps), with only a
 * system-error row to show for it. This check stops that where an offer leaves
 * draft: `publishOffer` (the CRM Send button and the MCP offer_send tool) and
 * the lead page's Activate Lead button, which sends credentials for a draft
 * offer without going through `publishOffer`. Anything that writes an offer's
 * status by hand (e.g. the MCP offer_update tool) is NOT covered.
 *
 * It looks ONLY at service types the old hard-coded list does not know — the
 * "new" services — and a historical name is skipped in any spelling or case
 * (activation matches names that way). So no historical offer can start being
 * refused. It reads three places because activation does: the service lines,
 * every package option's lines, and the offer's bundled-services list. A line
 * with no service type is a plain billing line and is never checked. Names are
 * compared exactly (no trimming) — activation creates the delivery under the
 * name as written, so "Apostille " with a stray space must not pass.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { isLegacyServiceType } from "@/lib/services"

export interface NewServiceCatalogInfo {
  /** The name staff see in the Service Catalog. */
  name: string
  /** False when the service has been switched off. */
  active: boolean
}

export interface OfferServiceSources {
  /** offers.services — the service lines. */
  services?: unknown
  /** offers.bundled_pipelines — the names activation creates deliveries from. */
  bundledPipelines?: unknown
  /** offers.packages — multi-option offers; each option has its own `services`. */
  packages?: unknown
}

function linesOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return (value as unknown[]).filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
}

/**
 * Distinct service names on the offer that are NOT historical types, exactly as
 * written, in the order found (lines, then package options, then the bundled list).
 */
export function newServiceTypesOnOffer(src: OfferServiceSources): string[] {
  const names: unknown[] = []
  for (const line of linesOf(src.services)) names.push(line.pipeline_type)
  for (const pkg of linesOf(src.packages)) {
    for (const line of linesOf(pkg.services)) names.push(line.pipeline_type)
  }
  if (Array.isArray(src.bundledPipelines)) names.push(...(src.bundledPipelines as unknown[]))

  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    if (typeof raw !== "string" || raw.trim() === "") continue
    if (isLegacyServiceType(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

/**
 * Pure: the plain-English reason this offer cannot be sent yet, or null.
 * `catalog` holds, per new type, its Service Catalog row (or null when the
 * catalog has no service with that pipeline name); `stageCounts` how many
 * steps are stored under that pipeline name.
 */
export function serviceReadinessProblem(p: {
  types: string[]
  catalog: Record<string, NewServiceCatalogInfo | null>
  stageCounts: Record<string, number>
}): string | null {
  const problems: string[] = []
  for (const type of p.types) {
    const row = Object.prototype.hasOwnProperty.call(p.catalog, type) ? p.catalog[type] : null
    if (!row) {
      problems.push(`"${type}" is not in the Service Catalog (check the spelling, capitals and spaces) — add it there, or remove the line.`)
      continue
    }
    if (!row.active) {
      problems.push(`"${row.name}" is switched off in the Service Catalog — switch it on, or remove the line.`)
      continue
    }
    const steps = Object.prototype.hasOwnProperty.call(p.stageCounts, type) ? p.stageCounts[type] : 0
    if (!steps) {
      problems.push(`"${row.name}" has no steps yet, so nothing could start after payment — add its steps in the Service Catalog first.`)
    }
  }
  return problems.length > 0 ? problems.join(" ") : null
}

/**
 * The same check against the live database (fresh reads — never the 60-second
 * service cache, because a refusal here must reflect what staff just saved).
 * Returns the reason the offer cannot be sent, or null when it can. Offers that
 * use only historical types answer null without touching the database. A lookup
 * failure refuses (closed) rather than letting an unchecked new service through.
 * "Switched off" means the same as in createSD: the catalog row is deprecated.
 */
export async function offerServicesReadinessProblem(src: OfferServiceSources): Promise<string | null> {
  const types = newServiceTypesOnOffer(src)
  if (types.length === 0) return null

  const [catalogRes, stagesRes] = await Promise.all([
    supabaseAdmin
      .from("catalog_entries")
      .select("slug, display_name, status, metadata")
      .eq("catalog_id", "services"),
    supabaseAdmin.from("pipeline_stages").select("service_type").in("service_type", types),
  ])
  if (catalogRes.error) return `could not check the services on this offer (${catalogRes.error.message}) — try again.`
  if (stagesRes.error) return `could not check the services on this offer (${stagesRes.error.message}) — try again.`

  // Same tie-break as buildServiceTypeMap: an active row beats a switched-off one, then the lower slug.
  const rows = [...(catalogRes.data ?? [])].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1
    const bActive = b.status === "active" ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
  const catalog: Record<string, NewServiceCatalogInfo | null> = {}
  for (const type of types) {
    const hit = rows.find((r) => {
      const pipeline = (r.metadata as Record<string, unknown> | null)?.pipeline
      return typeof pipeline === "string" && pipeline.trim() === type
    })
    catalog[type] = hit ? { name: hit.display_name, active: hit.status !== "deprecated" } : null
  }
  const stageCounts: Record<string, number> = {}
  for (const s of stagesRes.data ?? []) {
    stageCounts[s.service_type] = (stageCounts[s.service_type] ?? 0) + 1
  }
  return serviceReadinessProblem({ types, catalog, stageCounts })
}

/**
 * Same check for an offer that is still stored under `token` — for callers that
 * do not already hold the offer's rows (Activate Lead). A missing offer is the
 * caller's own error to report; here it simply has nothing to refuse.
 */
export async function offerReadinessProblemForToken(token: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("offers")
    // eslint-disable-next-line no-restricted-syntax -- packages postdates generated types (migration 20260826-1800)
    .select("services, bundled_pipelines, packages" as never)
    .eq("token", token)
    .maybeSingle()
  if (error) return `could not check the services on this offer (${error.message}) — try again.`
  if (!data) return null
  const row = data as unknown as { services?: unknown; bundled_pipelines?: unknown; packages?: unknown }
  return offerServicesReadinessProblem({
    services: row.services,
    bundledPipelines: row.bundled_pipelines,
    packages: row.packages,
  })
}
