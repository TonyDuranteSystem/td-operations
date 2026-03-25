/**
 * Test Record Filter
 *
 * Excludes records with is_test=true from aggregate queries.
 * Used by: crm_dashboard_stats, tax_tracker, sd_pipeline, crons, syncs.
 *
 * IMPORTANT: Existing rows have is_test=NULL (column added after data existed).
 * New test rows will have is_test=true. So we filter: NULL or false = keep.
 */

/**
 * Adds is_test filter to a Supabase query builder.
 * Keeps rows where is_test is NULL or false (i.e., excludes is_test=true).
 *
 * Usage:
 *   const query = supabaseAdmin.from('accounts').select('*')
 *   const filtered = excludeTestRecords(query)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function excludeTestRecords<T extends { or: (...args: any[]) => any }>(
  query: T
): T {
  return query.or('is_test.is.null,is_test.eq.false') as T
}

/**
 * SQL WHERE clause version for raw SQL queries.
 * Returns a string to append to WHERE conditions.
 *
 * Usage:
 *   const sql = `SELECT * FROM accounts WHERE status = 'Active' AND ${excludeTestSQL('accounts')}`
 */
export function excludeTestSQL(table?: string): string {
  const col = table ? `${table}.is_test` : 'is_test'
  return `(${col} IS NULL OR ${col} = false)`
}
