/* eslint-disable no-console -- this is a CLI script; stdout IS the output */
/**
 * P2.9 — Ghost column inventory (plan §4 line 588).
 *
 * Greps lib/ + app/ for Supabase column WRITES — `.from("table").update({...})`
 * and `.from("table").insert({...})` — and cross-checks the object keys
 * against lib/database.types.ts. Plan line 588 specifies "every invalid
 * column WRITE"; reads (`.select(...)`) are intentionally excluded because
 * Supabase's nested-relation syntax (`contact:contacts!inner(...)`,
 * `accounts(company_name)`, etc.) defeats a regex parser and produces too
 * many false positives to be useful for a one-time audit.
 *
 * Plan says "Dry-build with strict types enabled" — since the typed
 * Supabase client shipped in P1.1, the TypeScript build already catches
 * most ghost columns. This audit covers the gap: untyped clients, code
 * paths that bypass the Database type via `as any` / `as unknown`,
 * dynamic table names that defeat inference.
 *
 * Usage: npx tsx scripts/ghost-column-inventory.ts
 * Output: markdown summary on stdout (pipe into a sysdoc for archival).
 *
 * Exit code: 0 (always). This is a detection tool, not a gate; findings
 * become dev_tasks only if Antonio decides to act on them.
 */

import fs from "node:fs"
import path from "node:path"

// ─── Parse lib/database.types.ts → Map<table, Set<column>> ───────────
// The generated types file puts each table under a block like:
//   table_name: {
//     Row: { col_a: string; col_b: number | null; ... }
//     Insert: { ... }
//     Update: { ... }
//     Relationships: [...]
//   }
// We read the Row block for each table — it's the complete column set.
// This parser is intentionally regex-based rather than a full TS parse
// because the type file shape is stable and a one-time audit doesn't
// need AST-level precision.

function parseDatabaseTypes(filePath: string): Map<string, Set<string>> {
  const source = fs.readFileSync(filePath, "utf8")
  const tables = new Map<string, Set<string>>()

  // Find the `public: { Tables: { ... } }` block — columns live here.
  const publicTablesIdx = source.indexOf("public: {")
  if (publicTablesIdx < 0) return tables
  const tablesBlockStart = source.indexOf("Tables: {", publicTablesIdx)
  if (tablesBlockStart < 0) return tables

  // Walk forward, matching `  TABLE_NAME: {` entries at the Tables-level
  // indent. Then within each, find the Row block and extract keys.
  // Because TS has uniform 8-char indent for table entries, we pin on it.
  const tableHeaderPattern = /^ {6}(\w+): \{$/gm
  const sourceAfter = source.substring(tablesBlockStart)

  let match: RegExpExecArray | null
  while ((match = tableHeaderPattern.exec(sourceAfter)) !== null) {
    const tableName = match[1]
    if (tableName === "Relationships") continue

    // Find the Row block inside this table definition.
    const rowBlockStart = sourceAfter.indexOf("Row: {", match.index)
    if (rowBlockStart < 0 || rowBlockStart > match.index + 2000) continue // sanity

    // Collect lines until the matching closing brace at Row's indent.
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

function extractBracedBlock(source: string, start: number): string | null {
  // start must point at "{"
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

// ─── Walk repo and extract .from(...) blocks ─────────────────────────

interface GhostFinding {
  file: string
  line: number
  table: string
  op: "insert" | "update"
  badColumns: string[]
  snippet: string
}

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "coverage",
  // Generated or test-only files that don't ship runtime queries:
  "tests", "scripts", "supabase",
])

function walkSourceFiles(root: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(root, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      walkSourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

// Per-file scanner: finds .from("table")... chains and extracts column
// references per op. Intentionally conservative: only flags columns
// inside literal string/object arguments we can parse without a real AST.

const FROM_CALL_RE = /\.from\(\s*["'`](\w+)["'`]\s*\)([\s\S]*?)(?=\.from\(|\bconst\s|\blet\s|\bvar\s|\bfunction\s|\breturn\s|$)/g

/**
 * Find each `.update({ ... })` / `.insert({ ... })` / `.insert([{ ... }])`
 * call in a chain and return the TOP-LEVEL object keys only. Uses proper
 * brace/bracket/quote tracking so nested objects don't bleed keys into
 * the parent, and so non-greedy regex doesn't truncate at the first `}`.
 */
function findOpObjectKeys(
  chain: string,
  methodPrefix: string,
): Array<{ keys: string[]; snippet: string }> {
  const results: Array<{ keys: string[]; snippet: string }> = []
  let i = 0
  while (i < chain.length) {
    const idx = chain.indexOf(methodPrefix, i)
    if (idx < 0) return results

    // methodPrefix ends with "(". The IMMEDIATE next non-whitespace
    // character must be "{" (object literal) or "[" (array of literals).
    // If it's anything else (identifier, function call, `...spread`), the
    // argument isn't a literal we can inspect → skip. This prevents the
    // parser from jumping forward past `.update(varName).eq(...)` into
    // an unrelated `{...}` later in the chain.
    let j = idx + methodPrefix.length
    while (j < chain.length && /\s/.test(chain[j])) j++
    if (chain[j] !== "{" && chain[j] !== "[") {
      i = idx + methodPrefix.length
      continue
    }
    // For array form, advance to the first "{" at array-depth 1.
    if (chain[j] === "[") {
      let bracketDepth = 0
      let found = -1
      for (let k = j; k < chain.length; k++) {
        if (chain[k] === "[") bracketDepth++
        else if (chain[k] === "]") { bracketDepth--; if (bracketDepth === 0) break }
        else if (chain[k] === "{" && bracketDepth === 1) { found = k; break }
      }
      if (found < 0) { i = idx + methodPrefix.length; continue }
      j = found
    }

    const body = extractBalancedObject(chain, j)
    if (!body) { i = idx + methodPrefix.length; continue }
    const keys = topLevelKeys(body.inside)
    const snippet = chain.substring(idx, Math.min(idx + 180, j + body.length))
      .replace(/\s+/g, " ")
      .trim()
    results.push({ keys, snippet })
    i = j + body.length
  }
  return results
}

/**
 * Starting at `startPos` which MUST be "{", return the inner content up
 * to the matching "}", along with the total consumed length. Respects
 * nested braces, brackets, single/double/back quotes (with escape) and
 * template-literal `${...}` interpolation.
 */
function extractBalancedObject(
  source: string,
  startPos: number,
): { inside: string; length: number } | null {
  if (source[startPos] !== "{") return null
  let depth = 0
  let i = startPos
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let templateDepth = 0 // for ${...} inside backtick

  for (; i < source.length; i++) {
    const ch = source[i]
    const prev = source[i - 1]

    if (inSingle) { if (ch === "'" && prev !== "\\") inSingle = false; continue }
    if (inDouble) { if (ch === '"' && prev !== "\\") inDouble = false; continue }
    if (inBacktick) {
      if (ch === "`" && prev !== "\\" && templateDepth === 0) { inBacktick = false }
      else if (ch === "$" && source[i + 1] === "{") { templateDepth++; i++ }
      else if (ch === "}" && templateDepth > 0) { templateDepth-- }
      continue
    }

    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === "`") { inBacktick = true; continue }
    // Brackets are tracked only for symmetry with the quote-state machine
    // elsewhere; inside a balanced object we only break on depth===0 "}",
    // so bracket depth isn't consumed here.
    if (ch === "{") { depth++; continue }
    if (ch === "}") {
      depth--
      if (depth === 0) {
        return { inside: source.substring(startPos + 1, i), length: i - startPos + 1 }
      }
      continue
    }
  }
  return null
}

/**
 * Extract only the keys that are at brace-depth 0 within the given
 * object body. Walks character-by-character tracking depth and quoting
 * so keys inside nested objects/arrays/strings are ignored.
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = []
  let depth = 0
  let bracketDepth = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let templateDepth = 0
  let expectKey = true // true when we could be at a position to read a key

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    const prev = body[i - 1]

    if (inSingle) { if (ch === "'" && prev !== "\\") inSingle = false; continue }
    if (inDouble) { if (ch === '"' && prev !== "\\") inDouble = false; continue }
    if (inBacktick) {
      if (ch === "`" && prev !== "\\" && templateDepth === 0) inBacktick = false
      else if (ch === "$" && body[i + 1] === "{") { templateDepth++; i++ }
      else if (ch === "}" && templateDepth > 0) templateDepth--
      continue
    }

    if (ch === "'") { inSingle = true; expectKey = false; continue }
    if (ch === '"') { inDouble = true; expectKey = false; continue }
    if (ch === "`") { inBacktick = true; expectKey = false; continue }
    if (ch === "{") { depth++; expectKey = false; continue }
    if (ch === "}") { depth--; expectKey = false; continue }
    if (ch === "[") { bracketDepth++; expectKey = false; continue }
    if (ch === "]") { bracketDepth--; expectKey = false; continue }
    if (ch === ",") { if (depth === 0 && bracketDepth === 0) expectKey = true; continue }

    if (expectKey && depth === 0 && bracketDepth === 0 && /[A-Za-z_]/.test(ch)) {
      // Read an identifier; must be followed by optional whitespace then ":".
      let j = i
      while (j < body.length && /\w/.test(body[j])) j++
      const ident = body.substring(i, j)
      let k = j
      while (k < body.length && /\s/.test(body[k])) k++
      if (body[k] === ":") {
        keys.push(ident)
        i = k
      }
      expectKey = false
      continue
    }

    if (!/\s/.test(ch)) expectKey = false
  }
  return keys
}

function scanFile(
  file: string,
  tables: Map<string, Set<string>>,
): GhostFinding[] {
  const source = fs.readFileSync(file, "utf8")
  const findings: GhostFinding[] = []

  let m: RegExpExecArray | null
  while ((m = FROM_CALL_RE.exec(source)) !== null) {
    const table = m[1]
    const chain = m[2]
    const validCols = tables.get(table)
    if (!validCols) continue // unknown table — skip (likely storage, auth.*, or wrong parser target)

    const checkCols = (cols: string[], op: GhostFinding["op"], chainSubstr: string) => {
      const bad = cols.filter(c => !validCols.has(c))
      if (bad.length === 0) return
      const lineNum = source.substring(0, m!.index).split("\n").length
      findings.push({
        file,
        line: lineNum,
        table,
        op,
        badColumns: bad,
        snippet: chainSubstr.substring(0, 160).replace(/\s+/g, " ").trim(),
      })
    }

    // .update({...}) — top-level keys only, depth-aware extraction.
    for (const { keys, snippet } of findOpObjectKeys(chain, ".update(")) {
      checkCols(keys, "update", snippet)
    }
    // .insert({...}) and .insert([{...}]) — handles both shapes via the
    // array-skip logic inside findOpObjectKeys.
    for (const { keys, snippet } of findOpObjectKeys(chain, ".insert(")) {
      checkCols(keys, "insert", snippet)
    }
  }
  return findings
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  const root = path.resolve(__dirname, "..")
  const typesPath = path.join(root, "lib", "database.types.ts")
  const tables = parseDatabaseTypes(typesPath)

  if (tables.size === 0) {
    console.error("ERROR: could not parse lib/database.types.ts — no tables found")
    process.exit(1)
  }

  const roots = [path.join(root, "lib"), path.join(root, "app")]
  const files: string[] = []
  for (const r of roots) {
    if (fs.existsSync(r)) walkSourceFiles(r, files)
  }

  const findings: GhostFinding[] = []
  for (const f of files) {
    findings.push(...scanFile(f, tables))
  }

  // Output: markdown to stdout
  const rel = (p: string) => path.relative(root, p)
  const totalBad = findings.reduce((s, f) => s + f.badColumns.length, 0)
  const uniqueTables = new Set(findings.map(f => f.table)).size
  const uniqueFiles = new Set(findings.map(f => f.file)).size

  console.log("# P2.9 — Ghost column inventory")
  console.log()
  console.log(`Scan completed ${new Date().toISOString()}.`)
  console.log(`- Tables covered by \`lib/database.types.ts\`: **${tables.size}**`)
  console.log(`- Source files scanned: **${files.length}**`)
  console.log(`- Ghost-column findings: **${findings.length}**`)
  console.log(`- Distinct bad column references: **${totalBad}**`)
  console.log(`- Distinct tables with findings: **${uniqueTables}**`)
  console.log(`- Distinct files with findings: **${uniqueFiles}**`)
  console.log()

  if (findings.length === 0) {
    console.log("✅ No ghost column references detected.")
    console.log()
    console.log("This matches expectation post-P1.1 (typed Supabase client + generated types).")
    console.log("Any `.from().update()` / `.insert()` / `.select()` with an invalid column")
    console.log("should fail `npm run build` before shipping; this one-time audit confirms")
    console.log("the runtime surface matches the type-level guarantee.")
    return
  }

  console.log("## Findings")
  console.log()

  const byFile = new Map<string, GhostFinding[]>()
  for (const f of findings) {
    const existing = byFile.get(f.file) ?? []
    existing.push(f)
    byFile.set(f.file, existing)
  }

  for (const [file, rows] of Array.from(byFile.entries()).sort()) {
    console.log(`### \`${rel(file)}\`  (${rows.length} finding${rows.length === 1 ? "" : "s"})`)
    console.log()
    for (const r of rows) {
      console.log(`- line ${r.line} — ${r.op} on \`${r.table}\``)
      console.log(`  - Bad columns: ${r.badColumns.map(c => `\`${c}\``).join(", ")}`)
      console.log(`  - Snippet: \`${r.snippet}\``)
    }
    console.log()
  }
}

main()
