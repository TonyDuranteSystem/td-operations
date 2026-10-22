/**
 * Reading more rows than the database hands out in one answer (server; TD Marketing, dev job 9aec66fa). The database never returns more than 1000 rows to one request,
 * whatever limit is asked for, and says nothing when it cuts (proved on 2026-10-21: asked for 20001, got 1000). Every list that can pass 1000 rows is therefore read in
 * pages of 1000 until a short page or the cap, and the caller is told when something was left out. The page function must use a stable order (add the id as a tie-break).
 */
export const PAGE = 1000

export async function readPaged<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null }>, cap: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const out: T[] = []
  while (out.length <= cap) {
    const { data } = await page(out.length, out.length + PAGE - 1)
    const got = data ?? []
    out.push(...got)
    if (got.length < PAGE) break
  }
  return { rows: out.slice(0, cap), truncated: out.length > cap }
}
