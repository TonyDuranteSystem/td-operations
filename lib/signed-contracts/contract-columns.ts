/**
 * Reading `contracts` with the new `agreements` column (dev job 0a60f416) without ever breaking a page on a database that does not have it yet.
 *
 * The column is added by a migration that production gets on Antonio's word; a deploy can get ahead of it. A select that names a missing column
 * fails as a whole, and the company page / contact card would then say the contracts "could not be read". So: ask with the column, and when the
 * database says it does not know it, ask again without — the contracts then simply keep the name they always had.
 */
export async function selectWithAgreements<T>(
  run: (columns: string) => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  baseColumns: string,
): Promise<{ data: T | null; error: { message: string } | null }> {
  const first = await run(`${baseColumns}, agreements`)
  if (first.error && /agreements/i.test(first.error.message)) return run(baseColumns)
  return first
}
