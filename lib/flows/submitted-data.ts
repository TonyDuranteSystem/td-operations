/**
 * Pure helpers that turn a tax-wizard `submitted_data` JSONB blob into a clean,
 * grouped, human-readable structure for the flow Workspace DataViewer.
 *
 * The wizard stores a FLAT dictionary whose keys vary by entity type (SMLLC /
 * MMLLC / Corp). We deliberately do NOT assume a fixed schema — the grouping is
 * driven entirely by key shape:
 *   - Repeated entities are flattened as `<base>_<index>_<field>`
 *     (e.g. `member_0_member_first_name`, `bank_accounts_1_bank_name`) and are
 *     grouped back into per-index cards.
 *   - Remaining flat keys are bucketed into friendly sections by their leading
 *     token (`owner_`, `comp_`, `us_`), everything else falling to "Company".
 *
 * Values are normalized for display: booleans → Yes/No, numbers → string,
 * arrays of file paths → "N file(s)", empty/null → omitted.
 */

export interface DataField {
  label: string
  value: string
}

export interface DataGroup {
  title: string
  fields: DataField[]
}

/** Matches `<base>_<index>_<field>` — base is non-greedy so multi-word bases
 *  like `bank_accounts` are captured whole (the `_<digits>_` anchor forces it). */
const INDEXED_RE = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)*?)_(\d+)_(.+)$/

/** snake_case / kebab → Title Case. */
export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Naive singularize for entity-group titles ("bank_accounts" → "bank_account"). */
function singularize(base: string): string {
  return base.endsWith('s') ? base.slice(0, -1) : base
}

/**
 * Normalize a JSONB value for display. Returns null when the value carries no
 * information (so the field is omitted entirely).
 */
export function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'string') {
    const t = value.trim()
    return t === '' ? null : t
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    const allStrings = value.every((v) => typeof v === 'string')
    if (allStrings) {
      const looksLikeFiles = (value as string[]).some((v) => v.includes('/') || v.includes('.'))
      if (looksLikeFiles) return `${value.length} file${value.length === 1 ? '' : 's'}`
      return (value as string[]).map((v) => v.trim()).filter(Boolean).join(', ') || null
    }
    return `${value.length} item${value.length === 1 ? '' : 's'}`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length ? `${keys.length} field${keys.length === 1 ? '' : 's'}` : null
  }
  return null
}

/** Friendly section + how much of the key prefix to strip from the field label. */
function sectionFor(key: string): { section: string; strip: string } {
  if (key.startsWith('owner_')) return { section: 'Owner', strip: 'owner_' }
  if (key.startsWith('comp_')) return { section: 'Tax Questions', strip: 'comp_' }
  if (key.startsWith('us_')) return { section: 'US Activity', strip: 'us_' }
  return { section: 'Company', strip: '' }
}

// Stable display order for the flat sections.
const FLAT_SECTION_ORDER = ['Company', 'Owner']
const FLAT_SECTION_ORDER_TAIL = ['US Activity', 'Tax Questions']

/**
 * Group a flat `submitted_data` dict into ordered, display-ready sections.
 * Order: Company, Owner, then per-index entity cards (members, bank accounts…),
 * then US Activity, Tax Questions. Empty values and empty groups are dropped.
 */
export function groupSubmittedData(data: Record<string, unknown> | null | undefined): DataGroup[] {
  if (!data || typeof data !== 'object') return []

  const flatSections = new Map<string, DataField[]>()
  // base → index → fields
  const entities = new Map<string, Map<number, DataField[]>>()

  for (const [key, raw] of Object.entries(data)) {
    const value = formatValue(raw)
    if (value === null) continue

    const m = INDEXED_RE.exec(key)
    if (m) {
      const base = m[1]
      const index = Number(m[2])
      let field = m[3]
      // Strip a redundant repeat of the base prefix (member_0_member_first_name).
      if (field.startsWith(base + '_')) field = field.slice(base.length + 1)
      if (!entities.has(base)) entities.set(base, new Map())
      const byIndex = entities.get(base)!
      if (!byIndex.has(index)) byIndex.set(index, [])
      byIndex.get(index)!.push({ label: humanizeKey(field), value })
      continue
    }

    const { section, strip } = sectionFor(key)
    const label = humanizeKey(strip && key.startsWith(strip) ? key.slice(strip.length) : key)
    if (!flatSections.has(section)) flatSections.set(section, [])
    flatSections.get(section)!.push({ label, value })
  }

  const groups: DataGroup[] = []

  for (const section of FLAT_SECTION_ORDER) {
    const fields = flatSections.get(section)
    if (fields?.length) groups.push({ title: section, fields })
  }

  // Entity cards, bases sorted alphabetically, indexes ascending.
  for (const base of Array.from(entities.keys()).sort()) {
    const byIndex = entities.get(base)!
    for (const index of Array.from(byIndex.keys()).sort((a, b) => a - b)) {
      const fields = byIndex.get(index)!
      if (fields.length) {
        groups.push({ title: `${humanizeKey(singularize(base))} ${index + 1}`, fields })
      }
    }
  }

  for (const section of FLAT_SECTION_ORDER_TAIL) {
    const fields = flatSections.get(section)
    if (fields?.length) groups.push({ title: section, fields })
  }

  return groups
}
