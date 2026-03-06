/**
 * Remote MCP Server — TD Operations Hub
 *
 * Single endpoint that handles all MCP protocol traffic:
 *   POST /api/mcp  — Streamable HTTP (messages)
 *   GET  /api/mcp  — Streamable HTTP (SSE stream)
 *   DELETE /api/mcp — Session termination
 *   GET  /api/sse   — Legacy SSE transport
 *   POST /api/message — Legacy SSE message endpoint
 *
 * Auth: Bearer token in Authorization header (TD_MCP_API_KEY)
 *
 * Tools registered:
 *   crm_*  — Supabase CRM queries (accounts, contacts, payments, services, deals, tasks)
 *   qb_*   — QuickBooks Online (invoices, customers, payments, company info)
 *   email_*— Postmark transactional email (send, track opens/clicks, stats)
 *
 * Deploy: Vercel serverless function (Pro plan, 60s timeout)
 */

import { createMcpHandler } from "mcp-handler"
import { registerCrmTools } from "@/lib/mcp/tools/crm"
import { registerQbTools } from "@/lib/mcp/tools/qb"
import { registerEmailTools } from "@/lib/mcp/tools/email"

// Vercel Pro: 60s function timeout (required for DocAI, QB operations)
export const maxDuration = 60

// ─── MCP Server ──────────────────────────────────────────
const handler = createMcpHandler(
  (server) => {
    // Register all tool groups
    registerCrmTools(server)
    registerQbTools(server)
    registerEmailTools(server)

    // Future tool groups (uncomment as they're built):
    // registerDriveTools(server)
    // registerGmailTools(server)
    // registerDocaiTools(server)
    // registerClassifyTools(server)
    // registerCalendlyTools(server)
  },
  {
    serverInfo: {
      name: "td-hub",
      version: "1.0.0",
    },
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== "production",
  }
)

// ─── Auth Middleware ──────────────────────────────────────
// Simple Bearer token check against TD_MCP_API_KEY env var.
// All Claude clients send: Authorization: Bearer <key>

function withAuth(
  mcpHandler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const apiKey = process.env.TD_MCP_API_KEY

    // Dev mode: skip auth if key not configured (local testing only)
    if (!apiKey) {
      if (process.env.NODE_ENV === "development" || process.env.VERCEL_ENV === "development") {
        console.warn("[MCP] ⚠️ TD_MCP_API_KEY not set — running without auth (dev mode)")
        return mcpHandler(req)
      }
      return new Response(
        JSON.stringify({ error: "Server misconfigured: TD_MCP_API_KEY not set" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const authHeader = req.headers.get("Authorization")
    if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    }

    return mcpHandler(req)
  }
}

// ─── Export Route Handlers ───────────────────────────────
const authedHandler = withAuth(handler)

export {
  authedHandler as GET,
  authedHandler as POST,
  authedHandler as DELETE,
}
