/**
 * Keeping the offer builder's service list honest (flexible-offer track, "add a service from the offer").
 *
 * The Create Offer dialog loads the Service Catalog once. A service added (or changed) in another tab
 * was therefore missing from the dialog, or — worse — present with an old contract type, so the draft
 * was saved with the wrong contract. These pure helpers hold the rules; the dialog only calls them.
 * No fetch, no React: every rule is unit-tested in tests/unit/offer-catalog-refresh.test.ts.
 */

/** The fields of a catalog service that end up on the offer (name, job, contract, yearly fee). */
export interface ServiceListEntry {
  id: string
  name: string
  pipeline: string | null
  contract_type: string | null
  has_annual: boolean
}

/**
 * The rows of a /api/service-catalog reply, or null when the reply cannot be trusted.
 * null means "keep the list you already have": an expired login answers with an error or a page of
 * HTML, and a refresh that read it as "no services" would blank the list — and every ticked service
 * would then be saved with no job and no contract.
 */
export function parseServiceCatalogReply(ok: boolean, body: unknown): Array<Record<string, unknown>> | null {
  if (!ok || !body || typeof body !== "object") return null
  const services = (body as { services?: unknown }).services
  if (!Array.isArray(services)) return null
  const rows = services.filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s))
  return rows.length > 0 ? rows : null
}

export type NewServiceDecision =
  | { kind: "waiting" }
  | { kind: "tick"; id: string }
  | { kind: "several"; ids: string[] }

/**
 * After staff pressed "Add a new service", which service should be ticked on the offer?
 * `before` = the service ids on the list at that moment, `after` = the ids on the fresh list.
 * Exactly one new id → tick it. None yet → keep waiting (the other tab is still open). More than one
 * (someone else added a service too) → do not guess; staff pick. Ticking is decided by what is NEW,
 * never by matching a typed name: the name is editable and the system derives its own slug from it.
 */
export function decideNewService(before: readonly string[], after: readonly string[]): NewServiceDecision {
  const known = new Set(before)
  const fresh = Array.from(new Set(after)).filter((id) => !known.has(id))
  if (fresh.length === 0) return { kind: "waiting" }
  if (fresh.length === 1) return { kind: "tick", id: fresh[0] }
  return { kind: "several", ids: fresh }
}

/**
 * Between the list the screen is holding and a fresh read: which ticked services are gone
 * (switched off or removed) and which changed in a way the offer depends on (name, job, contract
 * type, yearly fee). A ticked service the screen never had counts as changed: the screen could not
 * have worked out its contract type. The dialog stops and asks before saving in either case.
 */
export function selectedServicesDrift(
  selectedIds: readonly string[],
  held: readonly ServiceListEntry[],
  fresh: readonly ServiceListEntry[],
): { missing: string[]; changed: string[] } {
  const heldById = new Map(held.map((s) => [s.id, s]))
  const freshById = new Map(fresh.map((s) => [s.id, s]))
  const missing: string[] = []
  const changed: string[] = []
  for (const id of Array.from(new Set(selectedIds))) {
    const now = freshById.get(id)
    if (!now) {
      missing.push(id)
      continue
    }
    const was = heldById.get(id)
    if (
      !was ||
      was.name !== now.name ||
      was.pipeline !== now.pipeline ||
      was.contract_type !== now.contract_type ||
      was.has_annual !== now.has_annual
    ) {
      changed.push(id)
    }
  }
  return { missing, changed }
}
