/**
 * CRM Store — pure rules shared by the server code and its tests (foundation slice 1).
 *
 * Every rule here reads CATALOG DATA passed in by the caller (storage_* catalogs),
 * never a hardcoded list, so staff can change the business rules without a deploy.
 * The SQL functions in scripts/migrations/20260924-2300-crm-store-foundation-s1.sql
 * implement the same normalisation (store_name_key, store_role_key); keep them in step.
 * Master plan v4.4 §8.1–8.4.
 */

/** Same as SQL store_name_key: trim, Unicode NFC, lowercase. */
export function storeNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase()
}

/** Same as SQL store_role_key: trim, collapse whitespace/underscores to one space, lowercase. */
export function storeRoleKey(role: string | null | undefined): string {
  return (role ?? "").trim().replace(/[\s_]+/g, " ").toLowerCase()
}

export interface ContactRoleEntry {
  slug: string
  matches: string[]
  appears_in_contacts: boolean
  portal_audience: boolean
}

/**
 * Map a free-text company–person role to a catalog role slug.
 * A missing role counts as the owner only when it is the company's single live link
 * (a single-member LLC whose owner link was saved without a role). Returns null when
 * nothing matches — the caller reports it rather than silently dropping the person.
 */
export function resolveContactRole(
  rawRole: string | null | undefined,
  roles: ContactRoleEntry[],
  isOnlyLiveLink: boolean,
): string | null {
  const key = storeRoleKey(rawRole)
  const hit = roles.find((r) => r.matches.includes(key))
  if (hit) return hit.slug
  if (key === "" && isOnlyLiveLink) return "owner"
  return null
}

export interface LifecycleMapEntry {
  account_status: string
  lifecycle: "active" | "archived"
  portal_visible: boolean
}

export type StoreLifecycle = "in_formation" | "in_onboarding" | "active" | "archived"

/**
 * Storage lifecycle is never stored for a company: it is read from the CRM status
 * through the catalog. Only storage-only overlays (in formation / in onboarding /
 * a cancelled formation's "archived") are stored on the owner and win.
 * Unknown status → "archived" (fail closed: not shown to clients).
 */
export function resolveLifecycle(
  override: "in_formation" | "in_onboarding" | "archived" | null,
  accountStatus: string | null,
  map: LifecycleMapEntry[],
): { lifecycle: StoreLifecycle; portalVisible: boolean } {
  if (override === "in_formation") return { lifecycle: "in_formation", portalVisible: true }
  if (override === "archived") return { lifecycle: "archived", portalVisible: false }
  const row = map.find((m) => m.account_status === accountStatus)
  if (!row) return { lifecycle: "archived", portalVisible: false }
  if (override === "in_onboarding") return { lifecycle: "in_onboarding", portalVisible: row.portal_visible }
  return { lifecycle: row.lifecycle, portalVisible: row.portal_visible }
}

export interface DocumentTypeEntry {
  slug: string
  personal: boolean
  draft_never_visible: boolean
}

export interface ClientSafeStagesEntry {
  service_type: string
  stages: string[]
}

export interface VisibilityInput {
  published: boolean
  filingStatus: "none" | "draft" | "filed" | "amended"
  documentType: string | null
  /** service type + the stage the file was created in, from its service-case link */
  serviceType: string | null
  stageAtCreation: string | null
}

/**
 * Is this file visible to the client in the portal? (fail closed)
 * Exactly today's rule — published OR created in a client-safe stage of its service —
 * plus: a type marked "draft never visible" is never shown while it is a draft
 * (e.g. the unsigned prepared tax return). WHO sees it (company members vs only the
 * person) is decided separately by the owner/personal rules.
 */
export function isClientVisible(
  f: VisibilityInput,
  types: DocumentTypeEntry[],
  safeStages: ClientSafeStagesEntry[],
): boolean {
  const type = f.documentType ? types.find((t) => t.slug === f.documentType) : undefined
  if (type?.draft_never_visible && f.filingStatus === "draft") return false
  if (f.published) return true
  if (!f.serviceType || !f.stageAtCreation) return false
  const entry = safeStages.find((s) => s.service_type === f.serviceType)
  return !!entry && entry.stages.includes(f.stageAtCreation)
}

/** Personal documents are private to their person (+ staff) wherever they are placed. */
export function isPersonalFile(
  ownerKind: "company" | "person" | "formation" | "unfiled",
  documentType: string | null,
  types: DocumentTypeEntry[],
): boolean {
  if (ownerKind === "person") return true
  const type = documentType ? types.find((t) => t.slug === documentType) : undefined
  return !!type?.personal
}
