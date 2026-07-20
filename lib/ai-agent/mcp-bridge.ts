/**
 * Generic MCP tool bridge — lets the assistant invoke ANY registered MCP tool by
 * name, in-process, without a hand-written case per tool.
 *
 * How: every tool file exposes register<X>Tools(server) and the ONLY method it calls
 * on `server` is .tool(name, description, schema, handler) (verified 2026-06-17). So
 * we run all the register functions against a "capture shim" — a fake server whose
 * .tool() records each handler + schema by name — producing a Map<name, entry>.
 * runToolByName() then re-validates params against the tool's own zod schema (the SDK
 * normally does this) and calls the handler, flattening the MCP result to a string.
 *
 * SAFETY: this bridge has NO risk policy of its own — it just makes tools callable.
 * The risk gate (lib/ai-agent/tool-risk.ts) MUST be consulted before calling a tool
 * through here; calling directly bypasses the MCP transport's auth boundary, so the
 * policy is the sole guard. The worker wiring (Step 2) enforces that; this module is
 * not wired in yet.
 */

import { z } from "zod"
import { coerceBridgeParams } from "./bridge-param-coercion"
import { executeTool, AGENT_TOOLS } from "./tools"

import { registerCrmTools } from "@/lib/mcp/tools/crm"
import { registerDriveTools } from "@/lib/mcp/tools/drive"
import { registerGmailTools } from "@/lib/mcp/tools/gmail"
import { registerDocaiTools } from "@/lib/mcp/tools/docai"
import { registerClassifyTools } from "@/lib/mcp/tools/classify"
import { registerCalendlyTools } from "@/lib/mcp/tools/calendly"
import { registerDocTools } from "@/lib/mcp/tools/doc"
import { registerStorageTools } from "@/lib/mcp/tools/storage"
import { registerSqlTools } from "@/lib/mcp/tools/sql"
import { registerHermesReadTools } from "@/lib/mcp/tools/hermes-read"
import { registerCodebaseReadTools } from "@/lib/mcp/tools/codebase-read"
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
import { registerDocumentGenerationTools } from "@/lib/mcp/tools/documents-generate"
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
import { registerITINFormTools } from "@/lib/mcp/tools/itin-form"
import { registerClosureTools } from "@/lib/mcp/tools/closure"
import { registerTaxQuoteTools } from "@/lib/mcp/tools/tax-quote"
import { registerBankStatementTools } from "@/lib/mcp/tools/bank-statements"
import { registerSignatureTools } from "@/lib/mcp/tools/signature"
import { registerTestingTools } from "@/lib/mcp/tools/testing"
import { registerHarborComplianceTools } from "@/lib/mcp/tools/harbor-compliance"
import { registerDevTaskTools } from "@/lib/mcp/tools/dev-tasks"
import { registerCalendarTools } from "@/lib/mcp/tools/calendar"
import { registerReferralTools } from "@/lib/mcp/tools/referrals"
import { registerLockTools } from "@/lib/mcp/tools/locks"
import { registerMemberInfoTools } from "@/lib/mcp/tools/member-info"
import { registerCatalogTools } from "@/lib/mcp/tools/catalog"
import { registerAgentMessageTools } from "@/lib/mcp/tools/agent-messages"
import { registerAgentApprovalTools } from "@/lib/mcp/tools/agent-approvals"
import { registerAgentThreadTools } from "@/lib/mcp/tools/agent-threads"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any, extra?: any) => Promise<unknown> | unknown
interface ToolEntry {
  description: string
  schema?: Record<string, z.ZodTypeAny>
  handler: ToolHandler
}

const REGISTERERS = [
  registerCrmTools, registerDriveTools, registerGmailTools, registerDocaiTools, registerClassifyTools,
  registerCalendlyTools, registerDocTools, registerStorageTools, registerSqlTools, registerHermesReadTools,
  registerCodebaseReadTools, registerMessagingTools, registerOfferTools, registerSysdocTools, registerKnowledgeTools,
  registerCirclebackTools, registerLeadTools, registerTaxTools, registerDeadlineTools, registerOperationsTools,
  registerCheckpointTools, registerDocumentGenerationTools, registerWhopTools, registerFormationTools, registerOnboardingTools, registerLeaseTools,
  registerOaTools, registerSs4Tools, registerWelcomePackageTools, registerBankingFormTools, registerJobTools,
  registerPortalTools, registerITINFormTools, registerClosureTools, registerTaxQuoteTools, registerBankStatementTools,
  registerSignatureTools, registerTestingTools, registerHarborComplianceTools, registerDevTaskTools, registerCalendarTools,
  registerReferralTools, registerLockTools, registerMemberInfoTools, registerCatalogTools, registerAgentMessageTools,
  registerAgentApprovalTools, registerAgentThreadTools,
]

let REGISTRY: Map<string, ToolEntry> | null = null

/** Build (once, memoized) the registry of every MCP tool, keyed by name. */
export function buildMcpToolRegistry(): Map<string, ToolEntry> {
  if (REGISTRY) return REGISTRY
  const reg = new Map<string, ToolEntry>()
  // server.tool signatures vary: (name, handler) | (name, desc, handler) |
  // (name, desc, schema, handler) | (name, desc, schema, annotations, handler).
  // The handler is always last; description is the first string; schema is the first
  // plain object (zod-shape) among the args.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shim: any = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (name: string, ...rest: any[]) => {
      const handler = rest[rest.length - 1] as ToolHandler
      const description = typeof rest[0] === "string" ? (rest[0] as string) : ""
      const schema = rest.find((r) => r && typeof r === "object" && !Array.isArray(r)) as
        | Record<string, z.ZodTypeAny>
        | undefined
      reg.set(name, { description, schema, handler })
    },
  }
  for (const register of REGISTERERS) register(shim)
  REGISTRY = reg
  return reg
}

/** Lightweight catalog (name + description) for the find_tool discovery helper. */
export function listBridgeTools(): Array<{ name: string; description: string }> {
  return Array.from(buildMcpToolRegistry().entries()).map(([name, e]) => ({ name, description: e.description }))
}

/**
 * Rewrite a catalog tool's fixed-choice params to their exact allowed spelling.
 *
 * Agent tools have had this for a long time; catalog tools never did, so a proposal
 * saying "inbound" was rejected for wanting "Inbound" and the assistant retried, gave up,
 * and asked the staff member to do it by hand. Applied BEFORE validation and hashing so
 * the stored values — the ones the confirmation card shows — are the ones that run.
 */
export function normalizeBridgeParams(name: string, params: Record<string, unknown>): Record<string, unknown> {
  const entry = buildMcpToolRegistry().get(name)
  if (!entry?.schema) return params
  return coerceBridgeParams(entry.schema as Record<string, unknown>, params)
}

/** Validate params against a bridge tool's own zod schema — used at propose time. */
export function validateBridgeToolParams(
  name: string,
  params: Record<string, unknown>,
): { ok: boolean; error?: string } {
  const entry = buildMcpToolRegistry().get(name)
  if (!entry) return { ok: false, error: `unknown tool "${name}"` }
  if (!entry.schema || Object.keys(entry.schema).length === 0) return { ok: true }
  const parsed = z.object(entry.schema).safeParse(params)
  if (parsed.success) return { ok: true }
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  }
}

/** Flatten an MCP tool result ({content:[{type:'text',text}]}) to a plain string. */
function flattenMcpResult(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: Array<{ text?: string }> }).content
    if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n")
  }
  return JSON.stringify(result)
}

const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name))

/**
 * Run a tool by name. Precedence: the curated agent tools (executeTool switch) win on
 * a name collision; otherwise dispatch through the MCP bridge with param re-validation.
 * Never throws — returns an error string (matches executeTool's contract).
 *
 * NOTE: this performs NO risk check. Callers MUST gate via decideAction() first.
 */
export async function runToolByName(name: string, params: Record<string, unknown> = {}): Promise<string> {
  if (AGENT_TOOL_NAMES.has(name)) return executeTool(name, params)
  const entry = buildMcpToolRegistry().get(name)
  if (!entry) return executeTool(name, params) // last resort — yields a clean "unknown tool" error
  try {
    let validated: Record<string, unknown> = params
    if (entry.schema && Object.keys(entry.schema).length > 0) {
      const parsed = z.object(entry.schema).safeParse(params)
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        return `❌ invalid params for ${name}: ${detail}`
      }
      validated = parsed.data as Record<string, unknown>
    }
    const result = await entry.handler(validated, {})
    return flattenMcpResult(result)
  } catch (err) {
    return `❌ ${name} error: ${err instanceof Error ? err.message : String(err)}`
  }
}
