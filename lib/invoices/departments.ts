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
