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
    "Execute a raw SQL query on the Supabase PostgreSQL database. Supports SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER. Returns JSON array of rows for SELECT, or error details. Use for any operation not covered by dedicated CRM/doc/drive tools.",
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
