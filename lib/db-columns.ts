/**
 * Single source of truth for "what columns does table X actually have",
 * parsed from the generated Supabase types (lib/database.types.ts).
 *
 * The generated file is regenerated on every push (pre-push P2.5 schema-drift
 * check), so it always reflects the real database. Parsing it lets build-time
 * guards (e.g. tests/unit/submission-record.test.ts) and the ghost-column
 * audit (scripts/ghost-column-inventory.ts) read the schema the SAME way and
 * never drift apart.
 *
 * Regex-based on the stable generated shape rather than a full TS parse — the
 * type file layout is fixed, and an AST parse would be overkill. Extracted
 * from scripts/ghost-column-inventory.ts (P2.9) so it can be imported by tests.
 */

import fs from "node:fs"
import path from "node:path"

/**
 * Parse the generated types file into Map<table, Set<column>>, reading each
 * table's `Row: { ... }` block (the complete column set). Returns an empty
 * map if the expected `public: { Tables: { ... } }` shape isn't found.
 */
export function parseDatabaseTypes(filePath: string): Map<string, Set<string>> {
  const source = fs.readFileSync(filePath, "utf8")
  const tables = new Map<string, Set<string>>()

  // Find the `public: { Tables: { ... } }` block — columns live here.
  const publicTablesIdx = source.indexOf("public: {")
  if (publicTablesIdx < 0) return tables
  const tablesBlockStart = source.indexOf("Tables: {", publicTablesIdx)
  if (tablesBlockStart < 0) return tables

  // Walk forward, matching `      TABLE_NAME: {` entries at the Tables-level
  // indent (6 spaces in the generated file). Within each, find the Row block.
  const tableHeaderPattern = /^ {6}(\w+): \{$/gm
  const sourceAfter = source.substring(tablesBlockStart)

  let match: RegExpExecArray | null
  while ((match = tableHeaderPattern.exec(sourceAfter)) !== null) {
    const tableName = match[1]
    if (tableName === "Relationships") continue

    const rowBlockStart = sourceAfter.indexOf("Row: {", match.index)
    if (rowBlockStart < 0 || rowBlockStart > match.index + 2000) continue // sanity

    const rowBody = extractBracedBlock(sourceAfter, rowBlockStart + "Row: ".length)
    if (!rowBody) continue

    const cols = new Set<string>()
    for (const line of rowBody.split("\n")) {
      // Match `  col_name: type` — ignore comments, empty lines, nested blocks.
      const colMatch = line.match(/^\s+(\w+)(\??):/)
      if (colMatch && colMatch[1] !== "Row" && colMatch[1] !== "Insert" && colMatch[1] !== "Update") {
        cols.add(colMatch[1])
      }
    }
    if (cols.size > 0) tables.set(tableName, cols)
  }
  return tables
}

/** Extract the contents of a `{ ... }` block. `start` must point at the `{`. */
export function extractBracedBlock(source: string, start: number): string | null {
  if (source[start] !== "{") return null
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.substring(start + 1, i)
    }
  }
  return null
}

/** Absolute path to this repo's generated Supabase types. */
export function defaultDatabaseTypesPath(): string {
  return path.join(process.cwd(), "lib", "database.types.ts")
}

/** Convenience: parse the repo's generated types into Map<table, Set<column>>. */
export function loadTableColumns(filePath: string = defaultDatabaseTypesPath()): Map<string, Set<string>> {
  return parseDatabaseTypes(filePath)
}
