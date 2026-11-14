/**
 * Booking tables may not exist yet on a database (the code is deployed BEFORE Antonio applies the migration on production). Every new reader and writer
 * treats "the table is not there" as "nothing here" — logged, never thrown — so a deploy ahead of its migration cannot break a page, a cron or the webhook.
 * 42P01 = Postgres "undefined_table"; PGRST205 = PostgREST "table not found in the schema cache".
 */
export function isMissingTable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === "42P01" || e.code === "PGRST205") return true
  return typeof e.message === "string" && /could not find the table|relation .* does not exist/i.test(e.message)
}

/** Postgres unique-violation. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "23505"
}
