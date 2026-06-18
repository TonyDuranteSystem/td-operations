/**
 * Expense-bucket catalog accessor (#2, 2026-06-18).
 *
 * Buckets are a FLEXIBLE, SHARED vocabulary in `catalog_entries`
 * (catalog_id='expense_categories'): seeded defaults + anything a client adds
 * (admin_can_add_rows). A bucket added by one client is offered to everyone.
 * The AI labeling pass, the add-bucket endpoint, and the review UI all read
 * the live list through here so there is one source of truth.
 */

export interface ExpenseBucket {
  slug: string
  label: string
}

/** Normalize a free-text bucket name a client typed into a stable slug, so
 *  "Gas ", "gas", "GAS" all dedupe to the same catalog row. */
export function slugifyBucket(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
}

/** Live active buckets, ordered by the catalog's sort_order then label.
 *  `db` is loosely typed to avoid the supabase-js "excessively deep" TS error. */
export async function getExpenseBuckets(db: { from: (t: string) => any }): Promise<ExpenseBucket[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data } = await db
    .from("catalog_entries")
    .select("slug, display_name, metadata")
    .eq("catalog_id", "expense_categories")
    .eq("status", "active")
  const rows = (data ?? []) as Array<{ slug: string; display_name: string; metadata: { sort_order?: number } | null }>
  return rows
    .map(r => ({ slug: r.slug, label: r.display_name, sort: Number(r.metadata?.sort_order ?? 500) }))
    .sort((a, b) => (a.sort - b.sort) || a.label.localeCompare(b.label))
    .map(({ slug, label }) => ({ slug, label }))
}
