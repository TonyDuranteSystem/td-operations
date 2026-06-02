/**
 * Hermes read-only tools — crm_query
 *
 * A locked, SELECT-only database read tool for the Hermes operating-agent.
 * Defense in depth:
 *   1. app-layer: must start with SELECT/WITH; reuse validateSQL() to reject
 *      any mutation / DDL / multi-statement / data-modifying CTE;
 *   2. app-layer: refuse credential/token tables;
 *   3. Postgres-enforced exec_sql_readonly() — transaction_read_only + sub-SELECT
 *      wrap (writes become syntax errors) + statement_timeout + LIMIT 500 +
 *      its own credential-table guard;
 *   4. result redaction — mask tax IDs / SSNs / emails / tokens before return.
 *
 * Hermes can NEVER write, deploy, read credentials, or touch production through
 * this tool. Pairs with migration 20260602-1600-crm-readonly-exec.sql.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { validateSQL } from "./sql"
import { redactSensitive } from "./sysdocs"

/** Credential/token tables Hermes must never read (matches the DB-function guard). */
export const BLOCKED_TABLES =
  /\b(hc_tokens|oauth_clients|oauth_codes|oauth_tokens|oauth_users|portal_welcome_tokens|qb_tokens)\b/i

/** Pure read-only gate used by crm_query. Returns an error string if the query
 * is not an allowed read, else null. Exported for unit testing. */
export function rejectIfNotReadOnly(query: string): string | null {
  if (!/^\s*(select|with)\b/i.test(query)) {
    return "crm_query is read-only: only SELECT (or WITH … SELECT) queries are allowed."
  }
  const v = validateSQL(query)
  if (!v.allowed || v.hasMutation) {
    return `crm_query is read-only and cannot run this query.${v.reason ? " " + v.reason : ""}`
  }
  if (BLOCKED_TABLES.test(query)) {
    return "Access to credential/token tables is not permitted."
  }
  return null
}

export function registerHermesReadTools(server: McpServer) {
  server.tool(
    "crm_query",
    "Read-only SQL against the CRM / operations database (SELECT only). Answers questions about clients, accounts, services, service_deliveries, payments, tasks, deadlines, offers, documents, leads, tax_returns, etc. CANNOT write, update, delete, deploy, or read credential/token tables. Results are capped at 500 rows; sensitive identifiers (tax IDs, SSNs, emails, tokens) are masked. Example: SELECT company_name, status FROM accounts WHERE status = 'active' LIMIT 20.",
    {
      query: z.string().describe("A single read-only SQL SELECT statement."),
    },
    async ({ query }) => {
      try {
        const rejection = rejectIfNotReadOnly(query)
        if (rejection) {
          return { content: [{ type: "text" as const, text: `❌ ${rejection}` }] }
        }

        // Execute via the Postgres-enforced read-only function.
        const { data, error } = await (supabaseAdmin as any).rpc("exec_sql_readonly", { sql_query: query })
        if (error) {
          return { content: [{ type: "text" as const, text: `❌ crm_query error: ${error.message}` }] }
        }
        if (data && typeof data === "object" && !Array.isArray(data) && (data as { error?: string }).error) {
          return { content: [{ type: "text" as const, text: `❌ crm_query rejected: ${(data as { error: string }).error}` }] }
        }

        const rows = Array.isArray(data) ? data : []
        const { text: safe } = redactSensitive(JSON.stringify(rows, null, 2))
        const capped = rows.length >= 500 ? "\n\n(note: results capped at 500 rows)" : ""
        return { content: [{ type: "text" as const, text: `${safe}${capped}` }] }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ crm_query error: ${err?.message || "unknown"}` }] }
      }
    }
  )
}
