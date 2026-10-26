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
import { isBuiltInAgreementType, isCustomContractType, isStandaloneAgreementType } from "@/lib/offers/standalone-contract-types"

export interface NewServiceCatalogInfo {
  /** The name staff see in the Service Catalog. */
  name: string
  /** The service's page address part (/service-catalog/<slug>/edit) — lets the refusal link straight to it. */
  slug?: string
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
  /** offers.contract_type — the contract the client signs. When given, a new service with its own contract must be in it. */
  contractType?: unknown
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

export interface ContractReadiness {
  /** The catalog row's contract type: empty/null = the service has no contract at all. */
  contractType: string | null
  /** For a stored (custom_*) contract: approved / only a draft / nothing yet. Ignored for other types. */
  state: "approved" | "draft" | "none"
}

/** Plain-English reason a NEW service's contract is not ready to be sold, or null. */
export function contractProblem(name: string, c: ContractReadiness): string | null {
  const t = (c.contractType ?? "").trim()
  if (!t) return `"${name}" has no contract yet, so the client would sign nothing for it — open it in the Service Catalog, create its contract and have the owner approve it.`
  if (isBuiltInAgreementType(t)) return null
  if (isCustomContractType(t)) {
    if (c.state === "approved") return null
    if (c.state === "draft") return `"${name}" has a contract draft that still needs the owner's approval — approve it in the Service Catalog (Contract), then send the offer again.`
    return `"${name}" has no contract yet — open it in the Service Catalog (Contract), create it and have the owner approve it.`
  }
  return `"${name}" has the contract type "${t}", which is not a contract the system knows — clear it in the Service Catalog and create the service's own contract there.`
}

/** One reason an offer cannot be sent yet, with — when it belongs to a catalog service — where to fix it. */
export interface ReadinessBlocker {
  message: string
  /** What is wrong, so the CRM pop-up can label its link ("Open contract" / "Open service"). */
  kind?: "contract" | "offer_type" | "steps" | "switched_off" | "not_in_catalog" | "lookup"
  serviceName?: string
  /** CRM address of the service's page, opened at its Contract card. */
  href?: string
}

const hrefFor = (slug: string | undefined) => (slug ? `/service-catalog/${encodeURIComponent(slug)}/edit#contract` : undefined)

/**
 * Pure: every reason this offer cannot be sent yet (empty = ready), each in plain English.
 * `catalog` holds, per new type, its Service Catalog row (or null when the
 * catalog has no service with that pipeline name); `stageCounts` how many
 * steps are stored under that pipeline name.
 */
export function serviceReadinessBlockers(p: {
  types: string[]
  catalog: Record<string, NewServiceCatalogInfo | null>
  stageCounts: Record<string, number>
  /** Per new type: its contract type and — for a stored (custom_*) contract — where its wording stands. Omitted = not checked. */
  contracts?: Record<string, ContractReadiness | undefined>
  /** The offer's own contract type, when known: an offer that is not a short-contract offer cannot carry a new service's agreement. */
  offerContractType?: unknown
  /** The contract types the offer's service lines already carry (a formation offer with a real formation line can carry add-on agreements). */
  offerLineTypes?: readonly string[]
  /** The same, per place the services sit — the main lines and each package option: every place holding a new service must be covered on its own. */
  offerGroups?: ReadonlyArray<{ pipelines: readonly string[]; types: readonly string[] }>
}): ReadinessBlocker[] {
  const out: ReadinessBlocker[] = []
  for (const type of p.types) {
    const row = Object.prototype.hasOwnProperty.call(p.catalog, type) ? p.catalog[type] : null
    if (!row) {
      out.push({ kind: "not_in_catalog", message: `"${type}" is not in the Service Catalog (check the spelling, capitals and spaces) — add it there, or remove the line.` })
      continue
    }
    const base = { serviceName: row.name, href: hrefFor(row.slug) }
    if (!row.active) {
      out.push({ ...base, kind: "switched_off", message: `"${row.name}" is switched off in the Service Catalog — switch it on, or remove the line.` })
      continue
    }
    const steps = Object.prototype.hasOwnProperty.call(p.stageCounts, type) ? p.stageCounts[type] : 0
    if (!steps) {
      out.push({ ...base, kind: "steps", message: `"${row.name}" has no steps yet, so nothing could start after payment — add its steps in the Service Catalog first.` })
    }
    const c = p.contracts?.[type]
    if (c) {
      const cp = contractProblem(row.name, c)
      if (cp) out.push({ ...base, kind: "contract", message: cp })
      // The service has its OWN contract, but the offer was set up for another one (typically created while the service had
      // no contract yet, so it fell back to the formation agreement): the client would pay for the service and never sign
      // its agreement. Say exactly how to fix it.
      const offerType = typeof p.offerContractType === "string" ? p.offerContractType.trim() : ""
      // The contract page treats an offer with no type as the formation contract, so this does too.
      const effective = offerType || "formation"
      // A short-contract offer shows the agreement itself. A REAL formation / onboarding offer (it has a line of that
      // kind) shows the new service's agreement as an add-on. Anything else — most often the formation FALLBACK of an
      // offer built while the service had no contract — cannot carry it.
      const carriesIn = (types: readonly string[]) => isStandaloneAgreementType(effective) || ((effective === "formation" || effective === "onboarding") && types.includes(effective))
      const groups = (p.offerGroups ?? []).filter((g) => g.pipelines.includes(type))
      const carries = groups.length > 0 ? groups.every((g) => carriesIn(g.types)) : carriesIn(p.offerLineTypes ?? [])
      if (p.offerContractType !== undefined && isCustomContractType(c.contractType) && !carries) {
        const used = offerType || "formation"
        // no link: the fix is to delete this draft and build the offer again, not to open the contract
        out.push({
          serviceName: row.name,
          kind: "offer_type",
          message: `"${row.name}" has its own contract, but this offer is set up with the "${used}" contract, so the client would not sign "${row.name}"'s agreement. The offer was probably created before the contract existed — delete this draft offer and create it again.`,
        })
      }
    }
  }
  return out
}

/** Pure: the plain-English reason this offer cannot be sent yet, or null. */
export function serviceReadinessProblem(p: Parameters<typeof serviceReadinessBlockers>[0]): string | null {
  const blockers = serviceReadinessBlockers(p)
  return blockers.length > 0 ? blockers.map((b) => b.message).join(" ") : null
}

/**
 * The same check against the live database (fresh reads — never the 60-second
 * service cache, because a refusal here must reflect what staff just saved).
 * Returns the reason the offer cannot be sent, or null when it can. Offers that
 * use only historical types answer null without touching the database. A lookup
 * failure refuses (closed) rather than letting an unchecked new service through.
 * "Switched off" means the same as in createSD: the catalog row is deprecated.
 */
export interface OfferReadiness {
  /** All reasons joined into one sentence (what the MCP tools and logs show), or null when ready. */
  problem: string | null
  /** The same reasons one by one, with links to fix them (what the CRM refusal pop-up shows). */
  blockers: ReadinessBlocker[]
}

/** A line's contract type, counting what its pipeline implies (the assistant tools leave the main formation / onboarding lines untyped). */
function impliedTypesOf(l: Record<string, unknown>): string[] {
  const out: string[] = []
  if (typeof l.contract_type === "string" && l.contract_type.trim()) out.push(l.contract_type.trim())
  const pipeline = typeof l.pipeline_type === "string" ? l.pipeline_type.trim().toLowerCase() : ""
  if (pipeline === "company formation") out.push("formation")
  if (pipeline === "client onboarding") out.push("onboarding")
  return out
}

/** The contract types the offer's service lines (and every package option's lines) already carry. */
function lineTypesOf(src: OfferServiceSources): string[] {
  const out: string[] = []
  for (const l of linesOf(src.services)) out.push(...impliedTypesOf(l))
  for (const pkg of linesOf(src.packages)) for (const l of linesOf(pkg.services)) out.push(...impliedTypesOf(l))
  return out
}

/** Pipeline names and contract types per place the services sit: the main lines, then each package option. */
function lineGroupsOf(src: OfferServiceSources): Array<{ pipelines: string[]; types: string[] }> {
  const group = (lines: Array<Record<string, unknown>>) => ({
    pipelines: lines.map((l) => (typeof l.pipeline_type === "string" ? l.pipeline_type : "")).filter(Boolean),
    types: lines.flatMap(impliedTypesOf),
  })
  return [group(linesOf(src.services)), ...linesOf(src.packages).map((pkg) => group(linesOf(pkg.services)))]
}

const READY: OfferReadiness = { problem: null, blockers: [] }
const lookupFailure = (m: string): OfferReadiness => ({ problem: m, blockers: [{ kind: "lookup", message: m }] })

export async function offerServicesReadinessProblem(src: OfferServiceSources): Promise<string | null> {
  return (await offerServicesReadiness(src)).problem
}

export async function offerServicesReadiness(src: OfferServiceSources): Promise<OfferReadiness> {
  const types = newServiceTypesOnOffer(src)
  if (types.length === 0) return READY

  const [catalogRes, stagesRes] = await Promise.all([
    supabaseAdmin
      .from("catalog_entries")
      .select("id, slug, display_name, status, metadata")
      .eq("catalog_id", "services"),
    supabaseAdmin.from("pipeline_stages").select("service_type").in("service_type", types),
  ])
  if (catalogRes.error) return lookupFailure(`could not check the services on this offer (${catalogRes.error.message}) — try again.`)
  if (stagesRes.error) return lookupFailure(`could not check the services on this offer (${stagesRes.error.message}) — try again.`)

  // Same tie-break as buildServiceTypeMap: an active row beats a switched-off one, then the lower slug.
  const rows = [...(catalogRes.data ?? [])].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1
    const bActive = b.status === "active" ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
  const catalog: Record<string, NewServiceCatalogInfo | null> = {}
  const entryIdByType: Record<string, string> = {}
  const contractTypeByType: Record<string, string | null> = {}
  for (const type of types) {
    const hit = rows.find((r) => {
      const pipeline = (r.metadata as Record<string, unknown> | null)?.pipeline
      return typeof pipeline === "string" && pipeline.trim() === type
    })
    catalog[type] = hit ? { name: hit.display_name, slug: hit.slug, active: hit.status !== "deprecated" } : null
    if (hit) {
      entryIdByType[type] = hit.id
      const ct = (hit.metadata as Record<string, unknown> | null)?.contract_type
      contractTypeByType[type] = typeof ct === "string" && ct.trim() ? ct.trim() : null
    }
  }

  // Where each stored (custom_*) contract stands — only asked when some service on the offer has one,
  // so offers without such a service never touch the contract store.
  const customEntryIds = types.filter((t) => isCustomContractType(contractTypeByType[t])).map((t) => entryIdByType[t])
  const stateByEntry: Record<string, "approved" | "draft"> = {}
  if (customEntryIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ctRows, error: ctErr } = await (supabaseAdmin as any)
      .from("service_contract_texts")
      .select("service_entry_id, status")
      .in("service_entry_id", customEntryIds)
      .in("status", ["approved", "draft"])
    if (ctErr) return lookupFailure(`could not check the contracts of the services on this offer (${ctErr.message}) — try again.`)
    for (const r of (ctRows as Array<{ service_entry_id: string; status: "approved" | "draft" }>) ?? []) {
      if (r.status === "approved" || !stateByEntry[r.service_entry_id]) stateByEntry[r.service_entry_id] = r.status
    }
  }
  const contracts: Record<string, ContractReadiness> = {}
  for (const type of types) {
    if (!catalog[type]) continue
    contracts[type] = { contractType: contractTypeByType[type] ?? null, state: stateByEntry[entryIdByType[type]] ?? "none" }
  }
  const stageCounts: Record<string, number> = {}
  for (const s of stagesRes.data ?? []) {
    stageCounts[s.service_type] = (stageCounts[s.service_type] ?? 0) + 1
  }
  const blockers = serviceReadinessBlockers({ types, catalog, stageCounts, contracts, offerContractType: src.contractType, offerLineTypes: lineTypesOf(src), offerGroups: lineGroupsOf(src) })
  return { problem: blockers.length > 0 ? blockers.map((b) => b.message).join(" ") : null, blockers }
}

/**
 * Same check for an offer that is still stored under `token` — for callers that
 * do not already hold the offer's rows (Activate Lead). A missing offer is the
 * caller's own error to report; here it simply has nothing to refuse.
 */
export async function offerReadinessProblemForToken(token: string): Promise<string | null> {
  return (await offerReadinessForToken(token)).problem
}

export async function offerReadinessForToken(token: string): Promise<OfferReadiness> {
  const { data, error } = await supabaseAdmin
    .from("offers")
    // eslint-disable-next-line no-restricted-syntax -- packages postdates generated types (migration 20260826-1800)
    .select("services, bundled_pipelines, packages, contract_type" as never)
    .eq("token", token)
    .maybeSingle()
  if (error) return lookupFailure(`could not check the services on this offer (${error.message}) — try again.`)
  if (!data) return READY
  const row = data as unknown as { services?: unknown; bundled_pipelines?: unknown; packages?: unknown; contract_type?: unknown }
  return offerServicesReadiness({
    services: row.services,
    bundledPipelines: row.bundled_pipelines,
    packages: row.packages,
    contractType: row.contract_type ?? null,
  })
}
