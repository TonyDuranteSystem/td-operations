/**
 * CRM Store — which folder is "the Tax folder" (or Company / Banking / …) of a storage. Pure, no database, so the
 * live code AND the all-owners comparison script use the very same rule.
 *
 * THE RULE (Change Name, Track S1): a fixed (template) folder kind is looked up ONLY among the DIRECT children of
 * the storage's top folder. A storage can hold more than one folder of the same kind once a company changes its
 * name: the previous fixed folders are moved into "Previous names › <old name>", and the company continues in a
 * fresh standard set. Looking a kind up "anywhere in the owner" (the old rule) could then hand back the archived
 * "3. Tax" and a new document would land in the archive.
 *
 * Today every storage has each fixed kind exactly once, always right under the top folder, and every year folder
 * sits directly in its Tax folder (proved on all owners, see docs/systems/storage.md) — so for those storages the
 * answer is exactly the one the old rule gave.
 */

export interface LookupFolder {
  id: string
  parent_id: string | null
  kind: string
  name?: string | null
  created_at?: string | null
}

/** The year folders live inside this fixed folder. */
export const YEAR_PARENT_KIND: Record<string, string> = { tax_year: "tax", person_tax_year: "person_tax" }

const time = (f: LookupFolder): number => {
  const t = f.created_at ? Date.parse(f.created_at) : NaN
  return Number.isNaN(t) ? 0 : t
}
/** Oldest first, then by id: the answer never depends on the order the database happened to return rows in. */
const oldestFirst = (a: LookupFolder, b: LookupFolder): number => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The storage's top folder: the one live folder with no parent. */
export function topFolder<T extends LookupFolder>(rows: T[]): T | null {
  return rows.find((r) => r.parent_id === null) ?? null
}

/** The live fixed folders of this kind directly under the top folder, oldest first. */
export function directChildrenOfKind<T extends LookupFolder>(rows: T[], kind: string): T[] {
  const root = topFolder(rows)
  if (!root) return []
  return rows.filter((r) => r.parent_id === root.id && r.kind === kind).sort(oldestFirst)
}

/**
 * The folder id for a fixed kind, or null when the storage has none.
 *  1. the oldest live folder of that kind directly under the top folder;
 *  2. else the top folder itself when it IS that kind (the Business / My files / Unfiled areas) — unless `includeRoot` is false.
 * A folder of that kind deeper in the tree is NEVER an answer.
 */
export function pickKindFolder<T extends LookupFolder>(rows: T[], kind: string, opts: { includeRoot?: boolean } = {}): string | null {
  const hit = directChildrenOfKind(rows, kind)[0]
  if (hit) return hit.id
  const root = topFolder(rows)
  if (root && root.kind === kind && opts.includeRoot !== false) return root.id
  return null
}

/** kind → folder id for the fixed folders directly under the top folder (oldest wins). Deeper kinds are not in it. */
export function topFolderIdsByKind<T extends LookupFolder>(rows: T[]): Map<string, string> {
  const root = topFolder(rows)
  const out = new Map<string, string>()
  if (!root) return out
  for (const f of rows.filter((r) => r.parent_id === root.id).sort(oldestFirst)) if (!out.has(f.kind)) out.set(f.kind, f.id)
  return out
}

/**
 * The year folder named `year` inside THIS storage's live Tax folder (any depth below it), or null.
 * `yearKind` is "tax_year" (company Tax) or "person_tax_year" (personal Tax). A year folder under "Previous names"
 * is never an answer.
 */
export function pickYearFolder<T extends LookupFolder>(rows: T[], yearKind: string, year: number | string): string | null {
  const parentKind = YEAR_PARENT_KIND[yearKind]
  if (!parentKind) return null
  const top = directChildrenOfKind(rows, parentKind)[0]
  if (!top) return null
  const children = new Map<string, T[]>()
  for (const r of rows) if (r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r])
  const found: T[] = []
  const seen = new Set<string>([top.id])
  const queue = [top.id]
  while (queue.length) {
    for (const c of children.get(queue.shift() as string) ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      queue.push(c.id)
      if (c.kind === yearKind && (c.name ?? "").trim() === String(year)) found.push(c)
    }
  }
  return found.sort(oldestFirst)[0]?.id ?? null
}

/** A folder kind is a plain lower-case word (template kinds): safe to put in a database filter. */
export function isPlainKind(kind: string): boolean {
  return /^[a-z0-9_]{1,40}$/.test(kind)
}
