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

/** The synthetic bucket every operating-expense row falls into when it has no
 *  recognized catalog bucket. Not a catalog row — computed on the fly. */
export const OTHER_BUCKET_SLUG = "other"
export const OTHER_BUCKET_LABEL = "Other"

/**
 * Is this row part of "Operating expenses" on the P&L? Mirrors computePnlTotals
 * exactly: booked expense + fee, PLUS uncategorized OUTFLOWS (which default to
 * business expense). COGS and distributions are shown on their own P&L lines, so
 * they are NOT operating expenses. Keep this in lockstep with computePnlTotals so
 * the category breakdown + drill-down can never drift from the headline total.
 */
export function isOperatingExpenseRow(category: string | null | undefined, amount: number): boolean {
  const cat = category ?? "uncategorized"
  return cat === "expense" || cat === "fee" || cat === "refund" || (cat === "uncategorized" && amount < 0)
}

/** S2 slice 6a — the per-row contribution to the operating-expenses breakdown,
 * with the SAME semantics as the P&L headline (computePnlTotals): SIGNED, so a
 * vendor reversal/refund REDUCES its bucket instead of inflating it. The old
 * Math.abs breakdown summed $2,067,145 while the headline said $1,937,283 on
 * Dynamiq 2024 (the client caught it) — the sum of these contributions over
 * every isOperatingExpenseRow row now equals the headline by construction. */
export function expenseBreakdownContribution(amount: number): number {
  return -amount
}

/** Build the operating-expense breakdown lines — headline-consistent (see
 * expenseBreakdownContribution). Shared by the portal and staff view routes. */
export function buildExpenseBreakdown(
  rows: Array<{ category: string | null; amount: number; ai_bucket: unknown }>,
  buckets: ExpenseBucket[],
): Array<{ slug: string; label: string; total: number }> {
  const bucketLabelMap = new Map(buckets.map(b => [b.slug, b.label]))
  const validSlugs = new Set(buckets.map(b => b.slug))
  const totals = new Map<string, number>()
  for (const r of rows) {
    if (!isOperatingExpenseRow(r.category, r.amount)) continue
    const slug = bucketSlugForRow(r.ai_bucket, validSlugs)
    totals.set(slug, (totals.get(slug) ?? 0) + expenseBreakdownContribution(r.amount))
  }
  return Array.from(totals.entries())
    .map(([slug, total]) => ({ slug, label: bucketLabelMap.get(slug) ?? OTHER_BUCKET_LABEL, total }))
    .sort((a, b) => b.total - a.total)
}

/** The breakdown bucket slug for a row: its ai_bucket when that is a known active
 *  catalog bucket, otherwise the synthetic "other". `validSlugs` is the live
 *  catalog slug set (from getExpenseBuckets). */
export function bucketSlugForRow(aiBucket: unknown, validSlugs: Set<string>): string {
  return typeof aiBucket === "string" && validSlugs.has(aiBucket) ? aiBucket : OTHER_BUCKET_SLUG
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
