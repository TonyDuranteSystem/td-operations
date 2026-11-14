/**
 * Filters for the Accounts and Contacts lists.
 *
 * Three INDEPENDENT dimensions on a company: its status, its client kind (accounts.account_type: Client / One-Time / Partner —
 * "one time" lives here, NOT in status) and its company type (accounts.entity_type, empty on some). A contact has none of its own;
 * the Contacts list asks "does one of this person's companies match" (match-ANY, one company satisfying every picked filter).
 *
 * Pure and client-safe. The number on each choice is the cross-filtered count: how many rows you would get if you picked that
 * choice with the OTHER filters as they are now.
 */

export const ACCOUNT_STATUS_CHOICES = ['Active', 'Offboarding', 'Closed', 'Cancelled'] as const
export const KIND_CHOICES = ['Client', 'One-Time'] as const
export const TYPE_CHOICES = [
  { value: 'Single Member LLC', label: 'SMLLC' },
  { value: 'Multi Member LLC', label: 'MMLLC' },
  { value: 'C-Corp Elected', label: 'C-Corp' },
] as const
/** URL value meaning "company type is empty". */
export const TYPE_NOT_SET = 'none'

/** What a company row needs for filtering. */
export interface FilterableCompany {
  status: string | null
  account_type: string | null
  entity_type: string | null
}

export interface CompanyFilters {
  /** a status value, or 'all' */
  status: string
  /** '' (all) | 'Client' | 'One-Time' */
  kind: string
  /** '' (all) | an entity type | 'none' */
  type: string
}

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? ''
}

/** Accounts page URL -> filters. Status defaults to Active (as today). */
export function parseAccountFilters(sp: { status?: string | string[]; kind?: string | string[]; type?: string | string[] }): CompanyFilters {
  return { status: one(sp.status) || 'Active', kind: one(sp.kind), type: one(sp.type) }
}

function typeMatches(entity: string | null, type: string): boolean {
  if (!type) return true
  if (type === TYPE_NOT_SET) return !entity
  return entity === type
}

export type FilterDimension = 'status' | 'kind' | 'type'

/** Does one company pass the filters? `skip` leaves one dimension out (used for the cross-filtered counts). */
export function companyMatches(c: FilterableCompany, f: CompanyFilters, skip?: FilterDimension): boolean {
  if (skip !== 'status' && f.status !== 'all' && c.status !== f.status) return false
  if (skip !== 'kind' && f.kind && c.account_type !== f.kind) return false
  if (skip !== 'type' && !typeMatches(c.entity_type, f.type)) return false
  return true
}

export interface AccountFacets {
  status: Record<string, number>
  kind: Record<string, number>
  type: Record<string, number>
}

/** The cross-filtered counts for the three segmented filters. `all` keys hold the "All" choice. */
export function accountFacetCounts(rows: FilterableCompany[], f: CompanyFilters): AccountFacets {
  const status: Record<string, number> = { all: 0 }
  for (const s of ACCOUNT_STATUS_CHOICES) status[s] = 0
  const kind: Record<string, number> = { all: 0 }
  for (const k of KIND_CHOICES) kind[k] = 0
  const type: Record<string, number> = { all: 0, [TYPE_NOT_SET]: 0 }
  for (const t of TYPE_CHOICES) type[t.value] = 0

  for (const r of rows) {
    if (companyMatches(r, f, 'status')) {
      status.all++
      if (r.status && r.status in status) status[r.status]++
    }
    if (companyMatches(r, f, 'kind')) {
      kind.all++
      if (r.account_type && r.account_type in kind) kind[r.account_type]++
    }
    if (companyMatches(r, f, 'type')) {
      type.all++
      if (!r.entity_type) type[TYPE_NOT_SET]++
      else if (r.entity_type in type) type[r.entity_type]++
    }
  }
  return { status, kind, type }
}

// ── Contacts ───────────────────────────────────────────────────────

export interface ContactFilters {
  /** '' (all) | 'with' (linked to a company) | 'none' (no company) */
  link: string
  /** '' (any) | a status value */
  cstatus: string
  kind: string
  ctype: string
}

export function parseContactFilters(sp: {
  link?: string | string[]
  cstatus?: string | string[]
  kind?: string | string[]
  ctype?: string | string[]
}): ContactFilters {
  const link = one(sp.link)
  return { link: link === 'with' || link === 'none' ? link : '', cstatus: one(sp.cstatus), kind: one(sp.kind), ctype: one(sp.ctype) }
}

/** True when any company-based filter (status / kind / type) is picked. */
export function hasCompanyFilter(f: ContactFilters): boolean {
  return !!(f.cstatus || f.kind || f.ctype)
}

/** One company passes the company filters (a single company must satisfy every picked one). */
export function contactCompanyMatches(c: FilterableCompany, f: ContactFilters): boolean {
  if (f.cstatus && c.status !== f.cstatus) return false
  if (f.kind && c.account_type !== f.kind) return false
  if (!typeMatches(c.entity_type, f.ctype)) return false
  return true
}

/** Does a person pass? `skipLink` leaves the Companies filter out (used for its own counts). */
export function contactMatches(companies: FilterableCompany[], f: ContactFilters, skipLink = false): boolean {
  if (!skipLink) {
    if (f.link === 'with' && companies.length === 0) return false
    if (f.link === 'none' && companies.length > 0) return false
  }
  if (hasCompanyFilter(f)) return companies.some((c) => contactCompanyMatches(c, f))
  return true
}

/** The Companies filter's counts: All / With a company / No company, with the other filters applied. */
export function contactLinkCounts(people: { companies: FilterableCompany[] }[], f: ContactFilters): { all: number; with: number; none: number } {
  const out = { all: 0, with: 0, none: 0 }
  for (const p of people) {
    if (!contactMatches(p.companies, f, true)) continue
    out.all++
    if (p.companies.length > 0) out.with++
    else out.none++
  }
  return out
}
