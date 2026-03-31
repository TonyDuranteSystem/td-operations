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
 * Auth: Two modes supported:
 *   1. Bearer token (TD_MCP_API_KEY) — for Claude Code / direct API access
 *   2. OAuth 2.1 access token — for Claude.ai custom connector
 *
 * Tools registered:
 *   execute_sql — Raw SQL queries on Supabase PostgreSQL
 *   crm_*      — Supabase CRM queries (accounts, contacts, payments, services, deals, tasks, create)
 *   lead_*     — Lead pipeline (search, get, create, update)
 *   tax_*      — Tax returns (search, tracker dashboard, update)
 *   deadline_* — Compliance deadlines (search, upcoming dashboard, update)
 *   task_tracker — Visual task board with priority/status/assignee breakdown
 *   sd_*       — Service delivery pipeline (search, pipeline view)
 *   conv_*     — Conversation history (log, search)
 *   sop_*      — Standard Operating Procedures (search, get)
 *   qb_*       — QuickBooks Online (invoices, customers, payments, company info)
 *   drive_*    — Google Drive (search, list, upload, read, create folder, move)
 *   gmail_*    — Gmail (search, read, read thread, draft, send, labels, attachments)
 *   docai_*    — Document AI OCR (extract text from PDFs/images)
 *   classify_* — Document classification (40+ rules, auto-detect type & category)
 *   cal_*      — Calendly (list bookings, event details, availability)
 *   doc_*      — Document Intelligence (process, search, list, stats)
 *   storage_*  — Supabase Storage (list, read, write, delete, move files)
 *   msg_*      — Messaging Hub (inbox, groups, search, send, channels)
 *   offer_*    — Client offers (create, get, update, list)
 *   sysdoc_*   — System documentation (read, list, update)
 *   kb_*       — Knowledge base (search, get, create, update articles & responses)
 *
 * Deploy: Vercel serverless function (Pro plan, 300s timeout)
 */

import { createMcpHandler } from "mcp-handler"
import { registerCrmTools } from "@/lib/mcp/tools/crm"
import { registerQbTools } from "@/lib/mcp/tools/qb"
import { registerDriveTools } from "@/lib/mcp/tools/drive"
import { registerGmailTools } from "@/lib/mcp/tools/gmail"
import { registerDocaiTools } from "@/lib/mcp/tools/docai"
import { registerClassifyTools } from "@/lib/mcp/tools/classify"
import { registerCalendlyTools } from "@/lib/mcp/tools/calendly"
import { registerDocTools } from "@/lib/mcp/tools/doc"
import { registerStorageTools } from "@/lib/mcp/tools/storage"
import { registerSqlTools } from "@/lib/mcp/tools/sql"
import { registerMessagingTools } from "@/lib/mcp/tools/messaging"
import { registerOfferTools } from "@/lib/mcp/tools/offers"
import { registerSysdocTools } from "@/lib/mcp/tools/sysdocs"
import { registerKnowledgeTools } from "@/lib/mcp/tools/knowledge"
import { registerCirclebackTools } from "@/lib/mcp/tools/circleback"
import { registerLeadTools } from "@/lib/mcp/tools/leads"
import { registerTaxTools } from "@/lib/mcp/tools/tax"
import { registerDeadlineTools } from "@/lib/mcp/tools/deadlines"
import { registerOperationsTools } from "@/lib/mcp/tools/operations"
import { registerCheckpointTools } from "@/lib/mcp/tools/checkpoint"
import { registerWhopTools } from "@/lib/mcp/tools/whop"
import { registerFormationTools } from "@/lib/mcp/tools/formation"
import { registerOnboardingTools } from "@/lib/mcp/tools/onboarding"
import { registerLeaseTools } from "@/lib/mcp/tools/lease"
import { registerOaTools } from "@/lib/mcp/tools/oa"
import { registerSs4Tools } from "@/lib/mcp/tools/ss4"
import { registerWelcomePackageTools } from "@/lib/mcp/tools/welcome-package"
import { registerBankingFormTools } from "@/lib/mcp/tools/banking-form"
import { registerJobTools } from "@/lib/mcp/tools/jobs"
import { registerPortalTools } from "@/lib/mcp/tools/portal"
import { registerQbExpenseTools } from "@/lib/mcp/tools/qb-expenses"
import { registerITINFormTools } from "@/lib/mcp/tools/itin-form"
import { registerClosureTools } from "@/lib/mcp/tools/closure"
import { registerTaxQuoteTools } from "@/lib/mcp/tools/tax-quote"
import { registerBankStatementTools } from "@/lib/mcp/tools/bank-statements"
import { registerSignatureTools } from "@/lib/mcp/tools/signature"
import { registerTestingTools } from "@/lib/mcp/tools/testing"
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions"
import { addReminderMiddleware } from "@/lib/mcp/reminder"

// Vercel Pro: 300s max for heavy operations (Magic Button, DocAI, bulk processing)
export const maxDuration = 300

// ─── MCP Server ──────────────────────────────────────────
const handler = createMcpHandler(
  (server) => {
    // Add reminder middleware BEFORE registering tools
    // Wraps every tool handler to inject checkpoint reminders
    addReminderMiddleware(server)

    // Register all tool groups
    registerCheckpointTools(server)
    registerCrmTools(server)
    registerQbTools(server)
    registerDriveTools(server)
    registerGmailTools(server)
    registerDocaiTools(server)
    registerClassifyTools(server)
    registerCalendlyTools(server)
    registerDocTools(server)
    registerStorageTools(server)
    registerSqlTools(server)
    registerMessagingTools(server)
    registerOfferTools(server)
    registerSysdocTools(server)
    registerKnowledgeTools(server)
    registerCirclebackTools(server)
    registerLeadTools(server)
    registerTaxTools(server)
    registerDeadlineTools(server)
    registerOperationsTools(server)
    registerWhopTools(server)
    registerFormationTools(server)
    registerOnboardingTools(server)
    registerLeaseTools(server)
    registerOaTools(server)
    registerSs4Tools(server)
    registerBankingFormTools(server)
    registerWelcomePackageTools(server)
    registerJobTools(server)
    registerPortalTools(server)
    registerQbExpenseTools(server)
    registerITINFormTools(server)
    registerClosureTools(server)
    registerTaxQuoteTools(server)
    registerBankStatementTools(server)
    registerSignatureTools(server)
    registerTestingTools(server)
  },
  {
    capabilities: {},
    instructions: SERVER_INSTRUCTIONS,
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
// Supports two auth methods:
// 1. Static Bearer token (TD_MCP_API_KEY) — Claude Code, direct API
// 2. OAuth 2.1 access token — Claude.ai custom connector
//
// Priority: check static key first (fast), then OAuth token (DB lookup)

import { validateAccessToken } from "@/lib/oauth"

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
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", error_description: "Bearer token required" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    }

    const token = authHeader.slice(7)

    // Method 1: Static API key (Claude Code)
    if (token === apiKey) {
      return mcpHandler(req)
    }

    // Method 2: OAuth access token (Claude.ai)
    const oauthResult = await validateAccessToken(token)
    if (oauthResult.valid) {
      return mcpHandler(req)
    }

    return new Response(
      JSON.stringify({ error: "Unauthorized", error_description: "Invalid or expired token" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    )
  }
}

// ─── Export Route Handlers ───────────────────────────────
const authedHandler = withAuth(handler)

export {
  authedHandler as GET,
  authedHandler as POST,
  authedHandler as DELETE,
}
