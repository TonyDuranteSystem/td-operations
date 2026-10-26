/**
 * Read EVERY row of a query that can hold more than one page. PostgREST answers at most 1000 rows per request, so a plain
 * `.select()` on a big table quietly returns the first 1000 — and the screen then shows wrong labels (e.g. "Top of the storage"
 * for a file whose folder was row 1001). The caller gives the query for one page; the query must have a stable `.order(...)`.
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < pageSize) return out
  }
}
