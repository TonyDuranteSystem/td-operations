/**
 * TD Marketing council fix (2026-10-18): the database lock that keeps a marketing login out of every table that is not marketing's own
 * is a function (public.marketing_lock_all_tables) that must be run again by every migration that creates a table. This pure check
 * reads a migration file's SQL and says what it forgot, so a unit test can fail the build before a forgotten lock ships.
 */

/** Migrations at or before this prefix predate the rule (the lock itself is in 20261018-0110). */
export const LOCK_RULE_AFTER = "20261018-0110"

/** The sortable prefix of a migration file name: YYYYMMDD-HHMM. */
export function migrationPrefix(fileName: string): string | null {
  const m = /^(\d{8}-\d{4})/.exec(fileName)
  return m ? m[1] : null
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")
}

export function createdTables(sql: string): string[] {
  const out: string[] = []
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
  let m: RegExpExecArray | null
  const clean = stripComments(sql)
  while ((m = re.exec(clean))) out.push(m[1].toLowerCase())
  return out
}

/** What this migration forgot. Empty = fine. `fileName` decides whether the rule applies at all. */
export function lockViolations(fileName: string, sql: string): string[] {
  const prefix = migrationPrefix(fileName)
  if (!prefix || prefix <= LOCK_RULE_AFTER || fileName.endsWith(".UNDO.sql")) return []
  const clean = stripComments(sql)
  const tables = createdTables(sql)
  const problems: string[] = []
  const ownTables = tables.filter(t => t.startsWith("marketing_"))
  const otherTables = tables.filter(t => !t.startsWith("marketing_"))
  if (otherTables.length && !/marketing_lock_all_tables\s*\(/i.test(clean)) {
    problems.push(`creates ${otherTables.join(", ")} but never calls SELECT public.marketing_lock_all_tables(); (a marketing login could read ${otherTables.length > 1 ? "them" : "it"})`)
  }
  for (const t of ownTables) {
    if (!new RegExp(`alter\\s+table\\s+(?:public\\.)?"?${t}"?\\s+enable\\s+row\\s+level\\s+security`, "i").test(clean)) {
      problems.push(`creates ${t} without ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`)
    }
  }
  return problems
}
