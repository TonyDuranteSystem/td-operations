/**
 * Pure: the documents grouped like the Storage's folders — "1. Company", "2. Contacts", "3. Tax" (a sub-section per year, newest first),
 * "4. Banking", "5. Correspondence", then anything without a folder. Inside a folder, files by name. (Drive cutover, dev job ad09ea91:
 * Antonio 2026-10-14 — the account's Documents tab for a company in the new storage is organised like the Storage, not one flat list.)
 */
export interface GroupableDoc {
  file_name: string
  category?: number | null
  tax_year?: number | null
}

export interface DocFolderGroup<T extends GroupableDoc> {
  key: string
  title: string
  count: number
  sections: Array<{ key: string; title: string | null; docs: T[] }>
}

const NAMES: Record<number, string> = { 1: 'Company', 2: 'Contacts', 3: 'Tax', 4: 'Banking', 5: 'Correspondence' }

export function groupByStorageFolder<T extends GroupableDoc>(docs: T[]): Array<DocFolderGroup<T>> {
  const byFolder = new Map<number, T[]>()
  for (const d of docs) {
    const n = typeof d.category === 'number' && d.category >= 1 && d.category <= 5 ? d.category : 99
    byFolder.set(n, [...(byFolder.get(n) ?? []), d])
  }
  const byName = (a: T, b: T) => (a.file_name || '').localeCompare(b.file_name || '')
  return Array.from(byFolder.keys()).sort((a, b) => a - b).map((n) => {
    const list = (byFolder.get(n) as T[]).slice().sort(byName)
    let sections: Array<{ key: string; title: string | null; docs: T[] }>
    if (n === 3) {
      const years = Array.from(new Set(list.map((d) => d.tax_year ?? 0))).sort((a, b) => b - a)
      sections = years.map((y) => ({ key: `y${y}`, title: y ? String(y) : 'No year', docs: list.filter((d) => (d.tax_year ?? 0) === y) }))
    } else {
      sections = [{ key: 'all', title: null, docs: list }]
    }
    return { key: `f${n}`, title: n === 99 ? 'Other' : `${n}. ${NAMES[n]}`, count: list.length, sections }
  })
}
