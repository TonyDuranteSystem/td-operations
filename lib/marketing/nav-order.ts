/**
 * The order of the sidebar entries as a person arranged them (pure; dev job 9aec66fa). Saved in the person's own browser as a list of keys; anything saved that no longer exists
 * is ignored, and an entry that is new (not in the saved list) goes at the end, so a new screen never disappears.
 */
export const NAV_ORDER_KEY = "tdm_nav_order"

export function orderNav<T extends { key: string }>(items: readonly T[], saved: readonly string[] | null | undefined): T[] {
  const byKey = new Map(items.map(i => [i.key, i]))
  const out: T[] = []
  for (const k of saved ?? []) { const it = byKey.get(k); if (it) { out.push(it); byKey.delete(k) } }
  for (const i of items) if (byKey.has(i.key)) out.push(i)
  return out
}

/** Move the entry at `index` one place up (-1) or down (+1); at an end it stays. */
export function moveNav<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const j = index + by
  if (index < 0 || index >= list.length || j < 0 || j >= list.length) return [...list]
  const out = [...list]
  ;[out[index], out[j]] = [out[j], out[index]]
  return out
}

export function parseSavedOrder(raw: string | null): string[] {
  return (raw ?? "").split(",").map(s => s.trim()).filter(s => /^[a-z-]{1,30}$/.test(s))
}
