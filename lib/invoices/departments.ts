/**
 * Invoice departments (dev job ac893719, Antonio 2026-11-05: invoices split into "TD clients" and "TD Marketing", flexible, not hardcoded).
 *
 * The departments are the rows of the catalog `invoice_departments` (R106: the catalog is the vocabulary, code never names a department):
 *   - metadata.is_default = true on EXACTLY ONE row: an invoice with no department stored belongs to it, permanently (today: TD clients);
 *   - metadata.origins    = the invoice origins a department owns (today: TD Marketing owns "marketing_sale"), so the code that creates an invoice asks
 *                           "which department owns this origin?" and a third department is a new catalog row, not new code;
 *   - metadata.sort_order = the order of the switches on the Finance screen.
 * Only a NON-default department is stored on an invoice (payments.department_entry_id); the default is "nothing stored".
 *
 * A broken catalog FAILS LOUD: zero or two defaults, or an origin nobody (or two departments) owns, throws a DepartmentConfigError. The caller must show the reason and retry; it
 * must never file the invoice under a department by guessing. Nothing here is cached: one tiny read, and an error is never remembered as "no department".
 */
import { listEntries, type CatalogEntry } from "@/lib/catalog/framework"

export const DEPARTMENTS_CATALOG = "invoice_departments"

/** The invoice origins that can be mapped to a department (a catalog row lists them in metadata.origins). */
export const INVOICE_ORIGINS = {
  /** The invoice and credit note Finance makes when a TD Marketing payment link is paid. */
  marketingSale: "marketing_sale",
} as const

export class DepartmentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DepartmentConfigError"
  }
}

type DepartmentEntry = Pick<CatalogEntry, "id" | "slug" | "display_name" | "status" | "metadata"> & { created_at?: string | null }

const meta = (e: DepartmentEntry): Record<string, unknown> => (e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : {})
const isDefault = (e: DepartmentEntry): boolean => meta(e).is_default === true
const originsOf = (e: DepartmentEntry): string[] => {
  const o = meta(e).origins
  return Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : []
}
const sortKey = (e: DepartmentEntry): number => (typeof meta(e).sort_order === "number" ? (meta(e).sort_order as number) : 1_000)

/** The department flagged as the default (whatever its status: a retired default still owns every invoice with nothing stored). Exactly one, or it throws. */
export function pickDefaultDepartment<T extends DepartmentEntry>(entries: readonly T[]): T {
  const flagged = entries.filter(isDefault)
  if (flagged.length === 0) throw new DepartmentConfigError("no invoice department is flagged as the default (metadata.is_default)")
  if (flagged.length > 1) throw new DepartmentConfigError(`${flagged.length} invoice departments are flagged as the default (${flagged.map(e => e.slug).join(", ")}); exactly one is allowed`)
  return flagged[0]
}

/**
 * The department that owns an invoice origin: an ACTIVE department whose metadata.origins lists it. Nobody owning it throws (the invoice would otherwise fall
 * back to the default without a word); two owners throw too (an origin listed on the default department as well would otherwise be filed under it silently).
 */
export function pickDepartmentForOrigin<T extends DepartmentEntry>(entries: readonly T[], origin: string): T {
  const owners = entries.filter(e => e.status === "active" && originsOf(e).includes(origin))
  if (owners.length === 0) throw new DepartmentConfigError(`no active invoice department owns the origin "${origin}" (metadata.origins)`)
  if (owners.length > 1) throw new DepartmentConfigError(`${owners.length} active invoice departments claim the origin "${origin}" (${owners.map(e => e.slug).join(", ")}); exactly one may own it`)
  return owners[0]
}

/** What to STORE on an invoice made for this origin: the owning department's id, or null when the owner is the default (nothing is stored for the default). */
export function departmentIdToStore<T extends DepartmentEntry>(entries: readonly T[], origin: string): string | null {
  const owner = pickDepartmentForOrigin(entries, origin)
  return pickDefaultDepartment(entries).id === owner.id ? null : owner.id
}

/**
 * The fields to spread into an invoice insert (or into a createTDInvoice call) for a department: the id when there is one, NOTHING when there is none.
 * An ordinary invoice therefore never names the column, so it can never be affected by this feature (nor by the column not existing yet).
 */
export function departmentFields(departmentEntryId: string | null | undefined): { department_entry_id?: string } {
  return departmentEntryId ? { department_entry_id: departmentEntryId } : {}
}

/** The switches the Finance screen shows, in order: every active department, plus any retired one still referenced by an invoice (the caller says which ids are). */
export function departmentsForSwitches<T extends DepartmentEntry>(entries: readonly T[], referencedIds: ReadonlySet<string> = new Set()): T[] {
  return entries
    .filter(e => e.status === "active" || referencedIds.has(e.id))
    .sort((a, b) => sortKey(a) - sortKey(b) || a.slug.localeCompare(b.slug))
}

/** What the Finance screen's department switch asks for. */
export type DepartmentFilter =
  | { kind: "all" }
  | { kind: "default" } // invoices with NO department stored (department_entry_id IS NULL)
  | { kind: "department"; id: string } // invoices stored under this non-default department

/**
 * Turn the `?dept=` value of the Finance screen into a filter. The value is a department slug from the catalog. Anything else (missing, empty, unknown, a
 * retired department nobody references) means "all" - a bad link shows everything, it never hides invoices or errors.
 * `referencedIds` lets a retired department that still holds invoices stay selectable (same rule as departmentsForSwitches).
 */
export function resolveDepartmentFilter<T extends DepartmentEntry>(
  entries: readonly T[],
  slug: string | null | undefined,
  referencedIds: ReadonlySet<string> = new Set(),
): DepartmentFilter {
  if (!slug) return { kind: "all" }
  const choice = departmentsForSwitches(entries, referencedIds).find(e => e.slug === slug)
  if (!choice) return { kind: "all" }
  return pickDefaultDepartment(entries).id === choice.id ? { kind: "default" } : { kind: "department", id: choice.id }
}

/** Does an invoice (by the department id stored on it, NULL = default) pass the filter? */
export function departmentFilterMatches(filter: DepartmentFilter, storedDepartmentId: string | null | undefined): boolean {
  if (filter.kind === "all") return true
  if (filter.kind === "default") return !storedDepartmentId
  return storedDepartmentId === filter.id
}

/**
 * Adds the department filter to a payments query builder IN PLACE (call it before the query is awaited, so it comes before any limit).
 * Takes `unknown` and narrows inside: the joined selects make the real builder types too deep for TypeScript to compare.
 */
export function applyDepartmentFilter(query: unknown, filter: DepartmentFilter): void {
  const q = query as { is: (c: string, v: null) => unknown; eq: (c: string, v: string) => unknown }
  if (filter.kind === "default") q.is("department_entry_id", null)
  else if (filter.kind === "department") q.eq("department_entry_id", filter.id)
}

export interface DepartmentSwitch {
  slug: string
  label: string
  count: number
}

/**
 * The switches to show, in order, each with how many invoices it holds. `rows` are the already-loaded invoices (only their stored department id matters).
 * A NULL id counts for the default department. A department with an id the catalog does not know is not counted anywhere (it cannot be shown either).
 */
export function buildDepartmentSwitches<T extends DepartmentEntry>(
  entries: readonly T[],
  rows: ReadonlyArray<{ department_entry_id?: string | null }>,
): DepartmentSwitch[] {
  const defaultId = pickDefaultDepartment(entries).id
  const counts = new Map<string, number>()
  for (const r of rows) {
    const id = r.department_entry_id || defaultId
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const referenced = new Set<string>()
  counts.forEach((n, id) => { if (n > 0) referenced.add(id) })
  return departmentsForSwitches(entries, referenced).map(e => ({ slug: e.slug, label: e.display_name, count: counts.get(e.id) ?? 0 }))
}

async function readDepartments(): Promise<CatalogEntry[]> {
  return listEntries(DEPARTMENTS_CATALOG, { includeDeprecated: true })
}

/** Every department row (any status), as the catalog stores them. */
export const listDepartments = readDepartments

export async function getDefaultDepartment(): Promise<CatalogEntry> {
  return pickDefaultDepartment(await readDepartments())
}

export async function getDepartmentForOrigin(origin: string): Promise<CatalogEntry> {
  return pickDepartmentForOrigin(await readDepartments(), origin)
}

/** The value to pass as `department_entry_id` when creating an invoice for this origin (null = the default department, pass nothing). */
export async function departmentIdToStoreForOrigin(origin: string): Promise<string | null> {
  return departmentIdToStore(await readDepartments(), origin)
}
