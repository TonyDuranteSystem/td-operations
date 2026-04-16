/**
 * P1.2 — CHECK constraint type generator
 *
 * Queries pg_constraint for CHECK definitions on TEXT columns in the public schema
 * and emits TypeScript union types as lib/db-check-types.ts.
 *
 * Usage: npx tsx scripts/gen-check-types.ts
 * Requires: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js"
import { writeFileSync } from "fs"
import { resolve } from "path"
import { config } from "dotenv"

config({ path: resolve(__dirname, "../.env.local") })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

interface CheckRow {
  table_name: string
  column_name: string
  check_def: string
}

function parseCheckValues(checkDef: string): string[] | null {
  // Match ARRAY['val1'::text, 'val2'::text, ...] pattern
  const arrayMatch = checkDef.match(/ARRAY\[([^\]]+)\]/)
  if (!arrayMatch) return null

  const values: string[] = []
  const valuePattern = /'([^']+)'::/g
  let match
  while ((match = valuePattern.exec(arrayMatch[1])) !== null) {
    values.push(match[1])
  }
  return values.length > 0 ? values : null
}

function toTypeName(tableName: string, columnName: string): string {
  // Convert table_name.column_name to PascalCase type name
  // e.g. "accounts" + "portal_tier" -> "AccountsPortalTier"
  const pascal = (s: string) =>
    s.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("")
  return `${pascal(tableName)}${pascal(columnName)}`
}

async function main() {
  const { data, error } = await supabase.rpc("exec_sql", {
    sql_query: `
      SELECT
        c.conrelid::regclass::text AS table_name,
        a.attname AS column_name,
        pg_get_constraintdef(c.oid) AS check_def
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      JOIN information_schema.columns ic
        ON ic.table_name = c.conrelid::regclass::text
        AND ic.column_name = a.attname
      WHERE c.contype = 'c'
        AND ic.table_schema = 'public'
        AND ic.data_type IN ('text', 'character varying')
      ORDER BY c.conrelid::regclass::text, a.attname
    `,
  })

  if (error) {
    console.error("Failed to query CHECK constraints:", error.message)
    process.exit(1)
  }

  const rows = data as CheckRow[]
  // Intentionally no timestamp in the generated file — the git log tells us
  // when it was last regenerated, and keeping the file deterministic is a
  // requirement of the P2.5 pre-push schema-drift check (every run must
  // produce byte-identical output when the schema hasn't changed).
  const lines: string[] = [
    "/**",
    " * Auto-generated CHECK constraint types from Supabase public schema.",
    " * Source: scripts/gen-check-types.ts",
    " * DO NOT EDIT — regenerate with: npx tsx scripts/gen-check-types.ts",
    " */",
    "",
  ]

  let count = 0
  for (const row of rows) {
    const values = parseCheckValues(row.check_def)
    if (!values) continue

    const typeName = toTypeName(row.table_name, row.column_name)
    const unionType = values.map(v => `"${v}"`).join(" | ")
    lines.push(`/** ${row.table_name}.${row.column_name} — CHECK constraint */`)
    lines.push(`export type ${typeName} = ${unionType}`)
    lines.push("")
    count++
  }

  const outPath = resolve(__dirname, "../lib/db-check-types.ts")
  writeFileSync(outPath, lines.join("\n"))
  // eslint-disable-next-line no-console
  console.log(`Generated ${count} CHECK constraint types → lib/db-check-types.ts`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
