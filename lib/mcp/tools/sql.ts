/**
 * SQL Tool — Execute raw SQL queries on Supabase
 *
 * CRITICAL tool: enables any query from MCP without needing
 * a dedicated tool for each operation. Read + write capability.
 *
 * Uses Postgres function exec_sql() which runs as SECURITY DEFINER.
 * Only callable via service_role key (revoked from anon/authenticated).
 *
 * SAFETY: All queries are validated before execution.
 * - DROP TABLE, TRUNCATE, ALTER TABLE DROP COLUMN → blocked
 * - UPDATE/DELETE without WHERE → blocked
 * - CTE bodies are analyzed for hidden mutations
 * - Multi-statement queries with mutations → blocked
 * - Dry-run count for UPDATE/DELETE on protected tables
 * - All mutations logged to action_log
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"

// Tables where mass operations (> per-table threshold) require explicit
// confirmation, and where all mutations require a `reason:` param (P2.3).
//
// Extended 2026-04-16 per plan §4 P2.3 directive "Add missing heavily-written
// tables to PROTECTED_TABLES" — based on P2.2 60-day traffic classification
// (`sysdoc_read('ops-2026-04-16-raw-sql-classification')`):
//   - `services`         — 260 writes/60d (heaviest non-protected target;
//                          cascade-delete target during account reclass)
//   - `pipeline_stages`  —  59 writes/60d (schema-adjacent; bad writes
//                          break auto-advance across all SDs)
//   - `client_invoices`  —  19 writes/60d (R027: TD systems NEVER write —
//                          guard codifies the rule in the execute_sql path)
export const PROTECTED_TABLES = [
  "accounts", "contacts", "payments", "services",
  "service_deliveries", "tax_returns", "tasks", "documents",
  "deals", "leads", "offers", "deadlines",
  // Added by P2.3:
  "pipeline_stages", "client_invoices",
  // Note: "services" is already in the list above.
]

// Per-table dry-run threshold (P2.3 directive: "Lower the 50-row dry-run
// threshold for core-pipeline tables like service_deliveries"). If a
// protected table is not listed here, DEFAULT_DRY_RUN_THRESHOLD applies.
export const DEFAULT_DRY_RUN_THRESHOLD = 50
export const PROTECTED_TABLE_THRESHOLDS: Record<string, number> = {
  service_deliveries: 10,
}

export function thresholdFor(table: string): number {
  return PROTECTED_TABLE_THRESHOLDS[table] ?? DEFAULT_DRY_RUN_THRESHOLD
}

// ─── SQL Preprocessing ───────────────────────────────────────

/** Remove SQL comments (-- line comments and /* block comments *\/) */
function stripComments(sql: string): string {
  // Remove block comments (non-greedy, handles nested poorly but good enough)
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, " ")
  // Remove line comments
  result = result.replace(/--[^\n]*/g, " ")
  return result
}

/** Split SQL on semicolons, respecting quoted strings */
function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  let inDollarQuote = false
  let dollarTag = ""

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]

    // Handle dollar quoting ($$...$$ or $tag$...$tag$)
    if (ch === "$" && !inSingleQuote && !inDoubleQuote) {
      const rest = sql.substring(i)
      const tagMatch = rest.match(/^\$([a-zA-Z_]*)\$/)
      if (tagMatch) {
        const tag = tagMatch[0]
        if (inDollarQuote && tag === dollarTag) {
          inDollarQuote = false
          current += tag
          i += tag.length - 1
          continue
        } else if (!inDollarQuote) {
          inDollarQuote = true
          dollarTag = tag
          current += tag
          i += tag.length - 1
          continue
        }
      }
    }

    if (inDollarQuote) {
      current += ch
      continue
    }

    // Handle single quotes (with escape handling)
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
      continue
    }

    // Handle double quotes
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
      continue
    }

    // Split on semicolons outside quotes
    if (ch === ";" && !inSingleQuote && !inDoubleQuote) {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ""
      continue
    }

    current += ch
  }

  const trimmed = current.trim()
  if (trimmed) statements.push(trimmed)

  return statements
}

/** Extract CTE bodies from a WITH statement: WITH x AS (DELETE FROM ...) → ["DELETE FROM ..."] */
function extractCteBodies(sql: string): string[] {
  const bodies: string[] = []
  // Match WITH ... AS ( ... ) patterns — extract the parenthesized body
  const ctePattern = /\bAS\s*\(\s*((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*)\s*\)/gi
  let match
  while ((match = ctePattern.exec(sql)) !== null) {
    if (match[1]) bodies.push(match[1].trim())
  }
  return bodies
}

// ─── Validation Types ────────────────────────────────────────

interface ValidationResult {
  allowed: boolean
  reason?: string
  isMutation: boolean
  mutationType?: "UPDATE" | "DELETE" | "INSERT"
  affectedTable?: string
  whereClause?: string
  /** For INSERT: tuple count parsed from VALUES (...) list. */
  insertRowCount?: number
}

/** Check a single SQL statement (or CTE body) for dangerous operations */
function validateStatement(stmt: string, _isCtebody = false): ValidationResult {
  const upper = stmt.replace(/\s+/g, " ").trim().toUpperCase()

  // 1. Block catastrophic DDL
  if (/\bDROP\s+TABLE\b/.test(upper)) {
    return { allowed: false, reason: "DROP TABLE is blocked. Use Supabase Dashboard for schema changes.", isMutation: true }
  }
  if (/\bTRUNCATE\b/.test(upper)) {
    return { allowed: false, reason: "TRUNCATE is blocked. Use DELETE with WHERE for targeted removal.", isMutation: true }
  }
  if (/\bALTER\s+TABLE\b.*\bDROP\s+COLUMN\b/.test(upper)) {
    return { allowed: false, reason: "ALTER TABLE DROP COLUMN is blocked. Use Supabase Dashboard for schema changes.", isMutation: true }
  }

  // 1b. Allow DDL statements (CREATE, ALTER) — they are not data mutations
  if (/^\s*(CREATE|ALTER)\b/.test(upper)) {
    return { allowed: true, isMutation: true }
  }

  // 2. Detect mutations
  const updateMatch = upper.match(/\bUPDATE\s+(?:ONLY\s+)?("?\w+"?\.)?"?(\w+)"?\b/)
  const deleteMatch = upper.match(/\bDELETE\s+FROM\s+(?:ONLY\s+)?("?\w+"?\.)?"?(\w+)"?\b/)
  const insertMatch = upper.match(/\bINSERT\s+INTO\s+("?\w+"?\.)?"?(\w+)"?\b/)

  if (updateMatch) {
    const table = updateMatch[2].toLowerCase()
    const hasWhere = /\bWHERE\b/.test(upper)
    if (!hasWhere) {
      return { allowed: false, reason: `UPDATE on "${table}" without WHERE clause is blocked. Add a WHERE filter to target specific rows.`, isMutation: true }
    }
    // Extract WHERE clause for dry-run
    const whereIdx = stmt.toUpperCase().indexOf("WHERE")
    const whereClause = whereIdx >= 0 ? extractWhereClause(stmt.substring(whereIdx + 5)) : undefined
    return { allowed: true, isMutation: true, mutationType: "UPDATE", affectedTable: table, whereClause }
  }

  if (deleteMatch) {
    const table = deleteMatch[2].toLowerCase()
    const hasWhere = /\bWHERE\b/.test(upper)
    if (!hasWhere) {
      return { allowed: false, reason: `DELETE FROM "${table}" without WHERE clause is blocked. Add a WHERE filter to target specific rows.`, isMutation: true }
    }
    const whereIdx = stmt.toUpperCase().indexOf("WHERE")
    const whereClause = whereIdx >= 0 ? extractWhereClause(stmt.substring(whereIdx + 5)) : undefined
    return { allowed: true, isMutation: true, mutationType: "DELETE", affectedTable: table, whereClause }
  }

  if (insertMatch) {
    const table = insertMatch[2].toLowerCase()
    // P2.3: count VALUES tuples as a crude insert-size estimate so we can
    // gate bulk INSERTs the same way we gate UPDATE/DELETE (plan directive
    // "Extend dry-run to INSERTs"). INSERT ... SELECT can't be counted
    // cheaply pre-execution — treated as 1 row; the protected-table mode
    // guard still forces a reason:.
    let insertRowCount = 1
    const valuesMatch = upper.match(/\bVALUES\s*\(/)
    if (valuesMatch) {
      // Count (...) tuples at top-level after the VALUES keyword.
      // Conservative: count opening parens after VALUES that look like
      // tuple starts (preceded by start-of-VALUES or comma+whitespace).
      const afterValues = stmt.substring((stmt.toUpperCase().indexOf("VALUES") + "VALUES".length))
      let depth = 0
      let tuples = 0
      let justSawComma = true // first "(" counts
      let inSingle = false
      for (let i = 0; i < afterValues.length; i++) {
        const ch = afterValues[i]
        if (ch === "'" && afterValues[i - 1] !== "\\") inSingle = !inSingle
        if (inSingle) continue
        if (ch === "(") {
          if (depth === 0 && justSawComma) tuples++
          depth++
        } else if (ch === ")") {
          depth--
        } else if (depth === 0) {
          if (ch === ",") justSawComma = true
          else if (!/\s/.test(ch)) justSawComma = false
        }
      }
      if (tuples > 0) insertRowCount = tuples
    }
    return {
      allowed: true,
      isMutation: true,
      mutationType: "INSERT",
      affectedTable: table,
      insertRowCount,
    }
  }

  // Read-only
  return { allowed: true, isMutation: false }
}

/** Extract WHERE clause, stopping at RETURNING, ORDER BY, LIMIT, GROUP BY, or end */
function extractWhereClause(afterWhere: string): string {
  const stopPattern = /\b(RETURNING|ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING|UNION|INTERSECT|EXCEPT)\b/i
  const match = afterWhere.match(stopPattern)
  if (match && match.index !== undefined) {
    return afterWhere.substring(0, match.index).trim()
  }
  return afterWhere.trim()
}

// ─── Main Validation ─────────────────────────────────────────

interface FullValidationResult {
  allowed: boolean
  reason?: string
  hasMutation: boolean
  dryRunNeeded: boolean
  dryRunTable?: string
  dryRunWhere?: string
  mutationType?: string
  /** For INSERT: estimated tuple count from VALUES parsing. */
  insertRowCount?: number
  /** True when the mutation targets a PROTECTED_TABLES entry. Drives the
   *  mandatory reason: check added in P2.3. */
  protectedTableTouched?: boolean
}

export function validateSQL(rawQuery: string): FullValidationResult {
  // Step 1: Strip comments
  const cleaned = stripComments(rawQuery)

  // Step 2: Split on semicolons
  const statements = splitStatements(cleaned)

  // Step 3: Block multi-statement with mutations
  if (statements.length > 1) {
    const hasMutation = statements.some(s => {
      const u = s.toUpperCase()
      return /\b(UPDATE|DELETE|INSERT|DROP|TRUNCATE|ALTER)\b/.test(u)
    })
    if (hasMutation) {
      return {
        allowed: false,
        reason: "Multi-statement queries containing mutations are blocked. Execute each statement separately for safety.",
        hasMutation: true,
        dryRunNeeded: false,
      }
    }
  }

  // Step 4: Validate each statement + CTE bodies
  let overallMutation = false
  let dryRunTable: string | undefined
  let dryRunWhere: string | undefined
  let mutationType: string | undefined
  let insertRowCount: number | undefined
  let protectedTableTouched = false

  function noteMutation(table: string | undefined) {
    if (table && PROTECTED_TABLES.includes(table)) protectedTableTouched = true
  }

  for (const stmt of statements) {
    // Check the main statement
    const result = validateStatement(stmt)
    if (!result.allowed) {
      return { allowed: false, reason: result.reason, hasMutation: true, dryRunNeeded: false }
    }
    if (result.isMutation) {
      overallMutation = true
      noteMutation(result.affectedTable)
      if (result.mutationType === "UPDATE" || result.mutationType === "DELETE") {
        dryRunTable = result.affectedTable
        dryRunWhere = result.whereClause
        mutationType = result.mutationType
      } else if (result.mutationType === "INSERT") {
        // Track INSERT for the dry-run gate; prefer UPDATE/DELETE dry-run
        // if one was already captured from the main statement (they use
        // a row-count query, while INSERT uses the parsed tuple count).
        if (!dryRunTable) {
          dryRunTable = result.affectedTable
          mutationType = result.mutationType
          insertRowCount = result.insertRowCount
        }
      }
    }

    // Check CTE bodies
    const cteBodies = extractCteBodies(stmt)
    for (const body of cteBodies) {
      const cteResult = validateStatement(body, true)
      if (!cteResult.allowed) {
        return { allowed: false, reason: `CTE body: ${cteResult.reason}`, hasMutation: true, dryRunNeeded: false }
      }
      if (cteResult.isMutation) {
        overallMutation = true
        noteMutation(cteResult.affectedTable)
        if (cteResult.mutationType === "UPDATE" || cteResult.mutationType === "DELETE") {
          dryRunTable = cteResult.affectedTable
          dryRunWhere = cteResult.whereClause
          mutationType = cteResult.mutationType
        } else if (cteResult.mutationType === "INSERT" && !dryRunTable) {
          dryRunTable = cteResult.affectedTable
          mutationType = cteResult.mutationType
          insertRowCount = cteResult.insertRowCount
        }
      }
    }
  }

  // Step 5: Determine if dry-run is needed (UPDATE/DELETE/INSERT on protected
  // tables). P2.3 extends this from UPDATE/DELETE-only to all three.
  const dryRunNeeded = !!(
    dryRunTable &&
    PROTECTED_TABLES.includes(dryRunTable) &&
    (mutationType === "UPDATE" || mutationType === "DELETE" || mutationType === "INSERT")
  )

  return {
    allowed: true,
    hasMutation: overallMutation,
    dryRunNeeded,
    dryRunTable,
    dryRunWhere,
    mutationType,
    insertRowCount,
    protectedTableTouched,
  }
}

// ─── Tool Registration ───────────────────────────────────────

export function registerSqlTools(server: McpServer) {

  // ═══════════════════════════════════════
  // execute_sql
  // ═══════════════════════════════════════
  server.tool(
    "execute_sql",
    "Execute raw SQL on the Supabase PostgreSQL database. Use this ONLY when no dedicated tool exists for the operation (e.g. complex joins, aggregations, or tables without a dedicated tool). Supports SELECT, INSERT, UPDATE, DELETE. Default mode is 'read' — rejects any mutation. Mutations (INSERT/UPDATE/DELETE/CREATE/ALTER, including those hidden in CTE bodies) REQUIRE mode='write' to be set explicitly. For SELECT: returns JSON array of rows. For mutations: use RETURNING clause. PREFER dedicated tools (crm_update_record, crm_search_*, doc_*, etc.) when available — they include validation and business logic. Writes to PROTECTED_TABLES require a `reason:` field explaining the change — logged to action_log.details.reason for the weekly audit report (P2.3).",
    {
      query: z.string().describe("SQL query to execute. For SELECT: returns rows as JSON array. For mutations: wrap in a CTE that returns affected rows, e.g. WITH updated AS (UPDATE ... RETURNING *) SELECT * FROM updated"),
      mode: z.enum(["read", "write"]).optional().default("read").describe("Execution mode. 'read' (default) rejects any mutation (INSERT/UPDATE/DELETE/CREATE/ALTER, including those hidden in CTE bodies). 'write' is required to perform any mutation. The model MUST set mode='write' explicitly to write — never implicitly. Pure SELECT queries run in any mode."),
      reason: z.string().optional().describe("Required for mutations touching a PROTECTED table (accounts, contacts, payments, services, service_deliveries, tax_returns, tasks, documents, deals, leads, offers, deadlines, pipeline_stages, client_invoices). Free-form 1-sentence explanation of WHY this raw SQL write is necessary (e.g. 'cascade cleanup for reclassified account a02bbfa7', 'stage backfill for null_stage SDs'). Logged to action_log.details.reason and surfaced in the weekly by-table report."),
    },
    async ({ query: sqlQuery, mode, reason }) => {
      try {
        const startMs = Date.now()
        let dryRunInfo: string | undefined

        // ─── SAFETY: Validate query before execution ───
        const validation = validateSQL(sqlQuery)

        if (!validation.allowed) {
          return {
            content: [{
              type: "text" as const,
              text: `🛑 BLOCKED: ${validation.reason}\n\nThe query was NOT executed. This safety check prevents accidental data loss.`,
            }],
          }
        }

        // ─── MODE GUARD: Mutations require mode='write' explicitly ───
        // Reuses validation.hasMutation from validateSQL(), which already inspects:
        //   - comment-stripped, whitespace-normalized, case-insensitive SQL
        //   - every statement in multi-statement queries
        //   - CTE bodies (WITH x AS (DELETE FROM ...) → detected)
        //   - CREATE/ALTER DDL (treated as mutation for mode-gating purposes)
        if (validation.hasMutation && mode !== "write") {
          const mutationLabel = validation.mutationType || "INSERT/UPDATE/DELETE/CREATE/ALTER"
          const tableLabel = validation.dryRunTable ? ` on "${validation.dryRunTable}"` : ""
          return {
            content: [{
              type: "text" as const,
              text: `🛑 BLOCKED (mode='read'): This query contains a mutation (${mutationLabel})${tableLabel}. The default execute_sql mode is 'read' and rejects any mutation. To perform this write, re-invoke with mode='write' explicitly. CTE bodies are inspected — wrapping a mutation inside a SELECT does not bypass this check.\n\nThe query was NOT executed.`,
            }],
          }
        }

        // ─── REASON: Require a reason: for writes on PROTECTED_TABLES (P2.3) ───
        // Applies to any mutation that touches a protected table (detected
        // via noteMutation() across main statement + CTE bodies).
        if (validation.protectedTableTouched && (!reason || reason.trim().length === 0)) {
          return {
            content: [{
              type: "text" as const,
              text: `🛑 BLOCKED: Writes to PROTECTED tables require a \`reason:\` field explaining WHY this raw SQL write is necessary. Protected tables: ${PROTECTED_TABLES.join(", ")}.\n\nRe-invoke with \`reason: "<1-sentence justification>"\` (e.g. "cascade cleanup for reclassified account a02bbfa7", "stage backfill for null_stage SDs"). The reason is logged to action_log.details.reason.\n\nThe query was NOT executed.`,
            }],
          }
        }

        // ─── DRY-RUN: Count affected rows for mutations on protected tables ───
        // P2.3 extensions:
        //   (a) Per-table threshold (service_deliveries=10, others=50).
        //   (b) INSERT gets a dry-run too, using the VALUES tuple count
        //       parsed during validation (INSERT ... SELECT counts as 1).
        if (validation.dryRunNeeded && validation.dryRunTable) {
          const threshold = thresholdFor(validation.dryRunTable)
          try {
            let affectedRows: number

            if (validation.mutationType === "INSERT") {
              affectedRows = validation.insertRowCount ?? 1
            } else {
              // UPDATE / DELETE path — require a WHERE clause.
              if (!validation.dryRunWhere) {
                // validateStatement already blocks WHERE-less UPDATE/DELETE,
                // so this branch is a defensive fallthrough.
                dryRunInfo = `[Dry-run: could not estimate affected rows — proceed with caution]`
                // Skip the threshold check and fall through to execution.
                affectedRows = 0
              } else {
                const countQuery = `SELECT count(*) as affected_rows FROM ${validation.dryRunTable} WHERE ${validation.dryRunWhere}`
                const { data: countData } = await supabaseAdmin.rpc("exec_sql", {
                  sql_query: countQuery,
                })

                const rows = (Array.isArray(countData) ? countData : []) as Array<Record<string, unknown>>
                affectedRows = (rows[0]?.affected_rows as number) ?? 0
              }
            }

            if (affectedRows > threshold) {
              return {
                content: [{
                  type: "text" as const,
                  text: `⚠️ DRY-RUN: This ${validation.mutationType} would affect ${affectedRows} rows in "${validation.dryRunTable}" (protected table, limit: ${threshold}).\n\nThe query was NOT executed. If you need to affect more than ${threshold} rows, split into smaller batches with more specific WHERE clauses (or fewer VALUES tuples for INSERT), or use the Supabase Dashboard for bulk operations.\n\nQuery: ${sqlQuery}`,
                }],
              }
            }

            dryRunInfo = `[Dry-run: ${affectedRows} row(s) will be affected in "${validation.dryRunTable}" (limit ${threshold})]`
          } catch {
            // If dry-run fails (e.g. complex WHERE), proceed with caution
            dryRunInfo = `[Dry-run: could not estimate affected rows — proceed with caution]`
          }
        }

        // ─── Execute the actual query ───
        const { data, error } = await supabaseAdmin.rpc("exec_sql", {
          sql_query: sqlQuery,
        })

        const elapsed = Date.now() - startMs

        if (error) {
          return {
            content: [{
              type: "text" as const,
              text: `❌ SQL Error: ${error.message}\nCode: ${error.code}\nDetails: ${error.details || "none"}`,
            }],
          }
        }

        // Check if the function returned an error object
        if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
          return {
            content: [{
              type: "text" as const,
              text: `❌ SQL Error: ${data.error}\nSQLSTATE: ${data.detail || "unknown"}`,
            }],
          }
        }

        // ─── AUDIT: Log mutations to action_log ───
        // P2.3: include `reason` in details so the weekly by-table report
        // can surface why each protected-table write happened.
        if (validation.hasMutation) {
          logAction({
            action_type: "execute_sql",
            table_name: validation.dryRunTable || "unknown",
            summary: `Raw SQL ${validation.mutationType || "mutation"}: ${sqlQuery.substring(0, 200)}${sqlQuery.length > 200 ? "..." : ""}`,
            details: {
              query: sqlQuery,
              mutation_type: validation.mutationType,
              table: validation.dryRunTable,
              protected_table_touched: validation.protectedTableTouched === true,
              reason: reason ?? null,
            },
          })
        }

        // Handle mutation success response (non-array)
        if (data && typeof data === "object" && !Array.isArray(data) && data.success) {
          const prefix = dryRunInfo ? `${dryRunInfo}\n` : ""
          return {
            content: [{
              type: "text" as const,
              text: `${prefix}✅ ${data.message || "Query executed successfully"} (${elapsed}ms)`,
            }],
          }
        }

        const rows = Array.isArray(data) ? data : []
        const rowCount = rows.length
        const prefix = dryRunInfo ? `${dryRunInfo}\n` : ""

        return {
          content: [{
            type: "text" as const,
            text: prefix + JSON.stringify({
              rows: rowCount <= 500 ? rows : rows.slice(0, 500),
              total_rows: rowCount,
              truncated: rowCount > 500,
              elapsed_ms: elapsed,
            }, null, 2),
          }],
        }
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ SQL execution failed: ${err.message}`,
          }],
        }
      }
    }
  )
}
