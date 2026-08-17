/* eslint-disable no-console -- CLI gate: reports its findings on stdout. */
/**
 * MIGRATION PROMOTION CHECK — does every schema-adding migration file actually
 * exist in the target database?
 *
 * WHY THIS EXISTS (2026-08-16 incident): `scripts/migrations/20260814-0100-offers-
 * commission-released-at.sql` was applied to sandbox, tested extensively, and the
 * code that depends on it shipped to production the same day — but the migration
 * itself was never promoted. Every production code path touching that column
 * failed for two days, including a cron running on its own schedule, before a
 * live production QA pass caught it. No existing check would have caught this:
 * the schema-drift check (`npm run gen:types`) regenerates types FROM PRODUCTION
 * and diffs against committed — when a column is missing from BOTH, that check
 * reports clean, because nothing has "drifted" relative to what was last
 * committed. This check answers a different question: not "did the schema
 * change since last commit" but "does every migration file we've ever written
 * actually exist in this database, right now."
 *
 * WHAT IT DOES: parses every scripts/migrations/*.sql file for ADD COLUMN and
 * CREATE TABLE statements, then checks live information_schema for each. Reports
 * exactly which migration + which column/table is missing.
 *
 * CONNECTION MODES (same dual-mode as check-db-constraints.ts, same reasoning):
 * dev machines are deliberately NEVER given production credentials (that is the
 * whole point of the sandbox-isolation system) — so this script does not, and
 * must not, gain one either. It connects to whatever SUPABASE_DB_URL points at.
 * On a dev machine that is sandbox. Checking PRODUCTION specifically is a
 * deliberate, occasional action taken by someone who actually holds a production
 * connection string (Antonio, or an agent session with properly-scoped MCP
 * access) — never a routine step baked into every developer's pre-push hook.
 *
 * Usage:
 *   npx tsx scripts/check-migration-promotion.ts                    # SUPABASE_DB_URL from .env.local
 *   npx tsx scripts/check-migration-promotion.ts --url=<connection-string>
 *
 * Exits non-zero if any migration's added column/table is missing.
 */

import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { config } from "dotenv"

config({ path: ".env.local" })

const MIGRATIONS_DIR = join(__dirname, "migrations")

interface AddedColumn {
  file: string
  table: string
  column: string
}

interface AddedTable {
  file: string
  table: string
}

/**
 * Deliberately simple, line-oriented parsing — matches this codebase's actual
 * migration style (one statement per logical line, `IF NOT EXISTS` throughout).
 * Not a SQL parser: misses anything written unusually, which is an acceptable
 * false-negative for a gate whose job is "catch the common case," not "parse
 * arbitrary SQL." A migration this can't parse is silently not checked, not
 * flagged as broken — see the summary output, which reports how many
 * statements were understood.
 */
function parseMigration(file: string, sql: string): { columns: AddedColumn[]; tables: AddedTable[] } {
  const columns: AddedColumn[] = []
  const tables: AddedTable[] = []

  // Table name may be schema-qualified (public.offers) — same fix as CREATE TABLE below.
  const addColumnRe = /ALTER TABLE\s+([\w.]+)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+(\w+)/gi
  for (const m of sql.matchAll(addColumnRe)) {
    const qualified = m[1]
    const table = qualified.includes(".") ? qualified.split(".").pop()! : qualified
    columns.push({ file, table, column: m[2] })
  }

  // Table name may be schema-qualified (public.foo) — capture the qualified form,
  // then keep only the part after the last dot. This exact miss (capturing
  // "public" as the table name) was caught live: see git history on this file.
  const createTableRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([\w.]+)/gi
  for (const m of sql.matchAll(createTableRe)) {
    const qualified = m[1]
    const table = qualified.includes(".") ? qualified.split(".").pop()! : qualified
    tables.push({ file, table })
  }

  return { columns, tables }
}

async function main() {
  const urlArg = process.argv.find((a) => a.startsWith("--url="))?.split("=")[1]
  const url = urlArg ?? process.env.SUPABASE_DB_URL
  if (!url) {
    console.error("Need a database connection string — pass --url=<connection-string> or set SUPABASE_DB_URL in .env.local.")
    process.exit(1)
  }

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))
  const allColumns: AddedColumn[] = []
  const allTables: AddedTable[] = []
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    const { columns, tables } = parseMigration(file, sql)
    allColumns.push(...columns)
    allTables.push(...tables)
  }

  console.log(`Parsed ${files.length} migration file(s): ${allColumns.length} ADD COLUMN statement(s), ${allTables.length} CREATE TABLE statement(s).\n`)

  const { Client } = await import("pg")
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await client.connect()

  try {
    const { rows: existingColumns } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    )
    const columnSet = new Set(existingColumns.map((r) => `${r.table_name}.${r.column_name}`))

    const { rows: existingTables } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const tableSet = new Set(existingTables.map((r) => r.table_name))

    const missingColumns = allColumns.filter((c) => !columnSet.has(`${c.table}.${c.column}`))
    const missingTables = allTables.filter((t) => !tableSet.has(t.table))

    if (missingColumns.length === 0 && missingTables.length === 0) {
      console.log(`PASS  Every migration-added column and table this script could parse exists in the target database.`)
      await client.end()
      return
    }

    for (const c of missingColumns) {
      console.log(`FAIL  ${c.file} adds ${c.table}.${c.column} — NOT FOUND in the target database.`)
    }
    for (const t of missingTables) {
      console.log(`FAIL  ${t.file} adds table ${t.table} — NOT FOUND in the target database.`)
    }
    console.log(`\n${missingColumns.length + missingTables.length} migration-file addition(s) missing from this database. If this is production, promote the listed migration(s) before shipping code that depends on them.`)
    await client.end()
    process.exit(1)
  } catch (err) {
    await client.end()
    throw err
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
