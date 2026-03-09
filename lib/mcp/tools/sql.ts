/**
 * SQL Tool — Execute raw SQL queries on Supabase
 *
 * CRITICAL tool: enables any query from MCP without needing
 * a dedicated tool for each operation. Read + write capability.
 *
 * Uses Postgres function exec_sql() which runs as SECURITY DEFINER.
 * Only callable via service_role key (revoked from anon/authenticated).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

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

        const rows = Array.isArray(data) ? data : []
        const rowCount = rows.length

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
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
