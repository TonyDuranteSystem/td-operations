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

// Tables where mass operations (>50 rows) require explicit confirmation
const PROTECTED_TABLES = [
  "accounts", "contacts", "payments", "services",
  "service_deliveries", "tax_returns", "tasks", "documents",
  "deals", "leads", "offers", "deadlines",
]

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
}

/** Check a single SQL statement (or CTE body) for dangerous operations */
function validateStatement(stmt: string, isCtebody = false): ValidationResult {
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
    return { allowed: true, isMutation: true, mutationType: "INSERT", affectedTable: table }
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
}

function validateSQL(rawQuery: string): FullValidationResult {
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

  for (const stmt of statements) {
    // Check the main statement
    const result = validateStatement(stmt)
    if (!result.allowed) {
      return { allowed: false, reason: result.reason, hasMutation: true, dryRunNeeded: false }
    }
    if (result.isMutation) {
      overallMutation = true
      if (result.mutationType === "UPDATE" || result.mutationType === "DELETE") {
        dryRunTable = result.affectedTable
        dryRunWhere = result.whereClause
        mutationType = result.mutationType
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
        if (cteResult.mutationType === "UPDATE" || cteResult.mutationType === "DELETE") {
          dryRunTable = cteResult.affectedTable
          dryRunWhere = cteResult.whereClause
          mutationType = cteResult.mutationType
        }
      }
    }
  }

  // Step 5: Determine if dry-run is needed (UPDATE/DELETE on protected tables)
  const dryRunNeeded = !!(
    dryRunTable &&
    PROTECTED_TABLES.includes(dryRunTable) &&
    (mutationType === "UPDATE" || mutationType === "DELETE")
  )

  return {
    allowed: true,
    hasMutation: overallMutation,
    dryRunNeeded,
    dryRunTable,
    dryRunWhere,
    mutationType,
  }
}

// ─── Tool Registration ───────────────────────────────────────

export function registerSqlTools(server: McpServer) {

  // ═══════════════════════════════════════
  // execute_sql
  // ═══════════════════════════════════════
  server.tool(
    "execute_sql",
    "Execute raw SQL on the Supabase PostgreSQL database. Use this ONLY when no dedicated tool exists for the operation (e.g. complex joins, aggregations, or tables without a dedicated tool). Supports SELECT, INSERT, UPDATE, DELETE. For SELECT: returns JSON array of rows. For mutations: use RETURNING clause. PREFER dedicated tools (crm_update_record, crm_search_*, doc_*, etc.) when available — they include validation and business logic.",
    {
      query: z.string().describe("SQL query to execute. For SELECT: returns rows as JSON array. For mutations: wrap in a CTE that returns affected rows, e.g. WITH updated AS (UPDATE ... RETURNING *) SELECT * FROM updated"),
    },
    async ({ query: sqlQuery }) => {
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

        // ─── DRY-RUN: Count affected rows for mutations on protected tables ───
        if (validation.dryRunNeeded && validation.dryRunTable && validation.dryRunWhere) {
          try {
            const countQuery = `SELECT count(*) as affected_rows FROM ${validation.dryRunTable} WHERE ${validation.dryRunWhere}`
            const { data: countData } = await supabaseAdmin.rpc("exec_sql", {
              sql_query: countQuery,
            })

            const rows = Array.isArray(countData) ? countData : []
            const affectedRows = rows[0]?.affected_rows ?? 0

            if (affectedRows > 50) {
              return {
                content: [{
                  type: "text" as const,
                  text: `⚠️ DRY-RUN: This ${validation.mutationType} would affect ${affectedRows} rows in "${validation.dryRunTable}" (protected table, limit: 50).\n\nThe query was NOT executed. If you need to affect more than 50 rows, split into smaller batches with more specific WHERE clauses, or use the Supabase Dashboard for bulk operations.\n\nQuery: ${sqlQuery}`,
                }],
              }
            }

            // Include dry-run info in the response later
            dryRunInfo = `[Dry-run: ${affectedRows} row(s) will be affected in "${validation.dryRunTable}"]`
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
        if (validation.hasMutation) {
          logAction({
            action_type: "execute_sql",
            table_name: validation.dryRunTable || "unknown",
            summary: `Raw SQL ${validation.mutationType || "mutation"}: ${sqlQuery.substring(0, 200)}${sqlQuery.length > 200 ? "..." : ""}`,
            details: {
              query: sqlQuery,
              mutation_type: validation.mutationType,
              table: validation.dryRunTable,
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
