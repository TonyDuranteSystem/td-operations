/** Small pure helpers for Antonio's Settings screen (TD Marketing, dev job 9aec66fa). */

/** "Lives in Italy, no business" -> "lives_in_italy_no_business" (a stored key: lower case letters, digits and underscores, at most 40 characters). */
export function slugKey(label: string): string {
  return label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/g, "")
}

export interface Option { key: string; label: string }

export interface OptionRow { key?: string | null; label: string }

/**
 * The reasons list after an edit. Each row the person edited keeps the key it started with, even when its label was renamed (leads already marked with
 * that reason stay correct); a row added in the editor has no key yet and gets a new one made from its label, made unique. Empty labels are dropped (and with
 * them a removed reason). Returns null when nothing usable is left.
 */
export function buildOptions(previous: readonly Option[], rows: readonly OptionRow[]): Option[] | null {
  const known = new Set(previous.map(o => o.key))
  const used = new Set<string>()
  const out: Option[] = []
  // first pass: rows that keep an existing key claim it, so a new row can never take a key that an old row still holds
  for (const r of rows) if (r.key && known.has(r.key)) used.add(r.key)
  const taken = new Set<string>(used)
  for (const r of rows) {
    const label = r.label.trim().replace(/\s+/g, " ").slice(0, 80)
    if (!label) continue
    let key: string
    if (r.key && known.has(r.key)) key = r.key
    else {
      const base = slugKey(label) || "reason"
      key = base
      for (let n = 2; taken.has(key) || known.has(key); n++) key = `${base.slice(0, 36)}_${n}`
      taken.add(key)
    }
    out.push({ key, label })
  }
  return out.length ? out : null
}

/** The checklist after an edit: trimmed, no blanks, no repeats, at most 40 items of 80 characters. */
export function cleanChecklist(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, 80)
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t) }
  }
  return out.slice(0, 40)
}
