/**
 * Address book: the one row the page draws, the filter chips and the search. Pure and client-safe (the browser filters the whole list itself, so a click is instant).
 * A row is either a CRM person (read only) or a person saved in the address book. A CRM person may carry a type Antonio confirmed ("effective type").
 */
import { CRM_KIND_IDS, CRM_KIND_TEXT, type CrmKind } from "@/lib/address-book/crm-kind"
import type { Box } from "@/lib/address-book/types"

export interface TypeDto {
  id: string
  slug: string
  name: string
  color: string | null
  sortOrder: number
  boxes: Box[]
  /** hidden = status deprecated: nobody can pick it any more, its people are kept */
  hidden: boolean
  /** people saved here with this type (hidden or not) — the number shown in "Manage types" */
  savedCount: number
}

export interface PersonRow {
  /** "contact:<id>" | "partner:<id>" | "saved:<id>" — unique across the list */
  key: string
  source: "crm" | "saved"
  /** the id inside its own table */
  id: string
  name: string
  company: string | null
  phone: string | null
  email: string | null
  /** what the CRM says (crm rows only) */
  crmKind: CrmKind | null
  /** the visible type this person is filed under: the saved type, or the type Antonio confirmed for a CRM person. null = none */
  typeId: string | null
  /** the Partners page's "Service area" (partner rows only) */
  serviceArea: string | null
  /** the values of the type's boxes (saved rows only) */
  extra: Record<string, string | number | boolean>
  /** the full detail, kept only for saved rows (they are edited from the page) */
  detail: SavedDetail | null
  /** lower-case text the search looks in: name, company, every email, every phone as typed and as digits */
  search: string
  createdAt: string | null
}

export interface SavedDetail {
  phones: string[]
  emails: string[]
  job_title: string | null
  website: string | null
  address: string | null
  notes: string | null
  source: string
}

export interface MatchDto {
  key: string
  source: "crm" | "saved"
  id: string
  name: string
  company: string | null
  /** "Client with a company", the saved type's name, … */
  what: string
  /** the CRM page of the person (CRM people only) */
  href: string | null
}

/** The chips: everyone, the CRM kinds, then Antonio's own types and "no type". */
export type FilterId = "all" | `crm:${CrmKind}` | `type:${string}` | "saved:none"

export function parseFilter(raw: string | null | undefined, types: readonly TypeDto[]): FilterId {
  const v = (raw ?? "").trim()
  if (v === "all" || v === "saved:none") return v
  if (v.startsWith("crm:") && (CRM_KIND_IDS as readonly string[]).includes(v.slice(4))) return v as FilterId
  if (v.startsWith("type:") && types.some((t) => t.id === v.slice(5))) return v as FilterId
  return "all"
}

export function rowMatchesFilter(row: PersonRow, filter: FilterId): boolean {
  if (filter === "all") return true
  if (filter === "saved:none") return row.source === "saved" && row.typeId === null
  if (filter.startsWith("type:")) return row.typeId === filter.slice(5)
  // a CRM kind chip: only CRM rows that no confirmed type of Antonio's has taken out of it
  return row.source === "crm" && row.typeId === null && row.crmKind === filter.slice(4)
}

export function searchMatches(row: PersonRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => {
      if (row.search.includes(part)) return true
      const digits = part.replace(/\D+/g, "")
      return digits.length >= 3 && row.search.includes(digits)
    })
}

export function filterRows(rows: readonly PersonRow[], filter: FilterId, query: string): PersonRow[] {
  return rows.filter((r) => rowMatchesFilter(r, filter) && searchMatches(r, query))
}

export interface ChipCounts {
  all: number
  crm: Record<CrmKind, number>
  types: Record<string, number>
  savedNone: number
}

export function chipCounts(rows: readonly PersonRow[]): ChipCounts {
  const out: ChipCounts = {
    all: rows.length,
    crm: Object.fromEntries(CRM_KIND_IDS.map((k) => [k, 0])) as Record<CrmKind, number>,
    types: {},
    savedNone: 0,
  }
  for (const r of rows) {
    if (r.typeId) out.types[r.typeId] = (out.types[r.typeId] ?? 0) + 1
    else if (r.source === "saved") out.savedNone += 1
    else if (r.crmKind) out.crm[r.crmKind] += 1
  }
  return out
}

/** What the "What they are" column says for a row. */
export function kindText(row: PersonRow, types: readonly TypeDto[]): string {
  if (row.typeId) return types.find((t) => t.id === row.typeId)?.name ?? "No type"
  if (row.source === "saved") return "No type"
  return row.crmKind ? CRM_KIND_TEXT[row.crmKind].row : "—"
}

/** Phone and email as the page lists them: the first one of each. */
export function firstOf(list: readonly (string | null | undefined)[]): string | null {
  for (const v of list) if (v && v.trim()) return v.trim()
  return null
}

/** The lower-case text a row is searched in. */
export function buildSearch(parts: { name: string; company?: string | null; emails: readonly (string | null | undefined)[]; phones: readonly (string | null | undefined)[]; extra?: readonly string[] }): string {
  const bits: string[] = [parts.name, parts.company ?? "", ...(parts.extra ?? [])]
  for (const e of parts.emails) if (e) bits.push(e)
  for (const p of parts.phones) {
    if (!p) continue
    bits.push(p)
    const d = p.replace(/\D+/g, "")
    if (d) bits.push(d)
  }
  return bits.join(" ").toLowerCase()
}

/** A person's name for sorting: accents and case ignored, a missing name last. */
export function sortKey(name: string): string {
  const n = name.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase()
  return n || "￿"
}
