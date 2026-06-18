/**
 * Tool risk classifier + policy — the SAFETY CORE of the flexible action surface.
 *
 * Given a tool name (+ the resolved params for that call), decide whether the
 * assistant may run it automatically (READ), must queue it for Antonio's approval
 * (WRITE_INTERNAL / EXTERNAL), or may not run it at all (hard-blocked).
 *
 * Design invariants:
 *  - FAIL-SAFE: anything not confidently classified READ defaults to EXTERNAL
 *    (requires approval). A misread here is the one catastrophic failure mode, so
 *    the default always errs toward "ask Antonio".
 *  - Parameter-aware: a tool that is read-only by default but mutates/sends when a
 *    flag is set (e.g. *_form_review with apply_changes, *_prepare_documents with
 *    send_email) escalates to EXTERNAL based on the RESOLVED params, not the name.
 *  - Pure + deterministic → exhaustively unit-testable, and the generated
 *    classification table is hand-reviewed before anything is wired in.
 *
 * This module performs NO I/O and is not wired into the worker yet (Step 1).
 */

export type RiskTier = "READ" | "WRITE_INTERNAL" | "EXTERNAL"
export type ToolDecision = "auto" | "approval" | "blocked"

/** Tools the assistant may NEVER invoke — raw escape hatches / test scaffolding. */
export const HARD_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "execute_sql", // raw production SQL writes — never via the assistant
  "test_setup",
  "test_cleanup",
])

/**
 * Curated EXTERNAL / high-risk tools: leave TD, move money, are irreversible, or
 * trigger client communications. Always EXTERNAL regardless of naming. Seeded from
 * the 2026-06-17 tool-surface audit; review/extend as the surface grows.
 */
export const EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
  "gmail_send", "gmail_draft",
  "offer_send", "offer_resend",
  "lease_send", "oa_send", "itin_form_send",
  "portal_invoice_create", "portal_invoice_send", "portal_create_user",
  "portal_chat_send", "portal_team_send", "portal_transition_setup", "portal_transition_batch",
  "sd_advance_stage", "service_deactivate", "service_reactivate",
  "referral_payout", "tax_send_to_accountant", "formation_confirm",
  "drive_delete", "storage_delete", "agent_msg_send",
  "calendar_create_event", "calendar_update_event", "calendar_delete_event",
  "hc_submit_ra_change",
  "whop_create_product", "whop_update_product", "whop_delete_product",
  "whop_create_plan", "whop_update_plan",
  "signature_request_create",
])

/**
 * Curated definitely-READ tools whose names don't match the read heuristic.
 * Each was verified read-only by reading its handler (2026-06-17) — it performs no
 * insert/update/delete/upload/send. Tools that LOOK like reads but write under a
 * parameter (doc_map_folders dry_run, catalog_pending action=resolve, hc_download_
 * delivery uploads to Drive) are deliberately NOT here — they stay gated to approval.
 */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "crm_query", "audit_crm", "bank_statement_pnl", "bank_statement_review",
  "docai_ocr_file", "cron_status",
  // Verified read-only during the Step-1 curation:
  "classify_document", "classify_text", "doc_compliance_check", "gmail_labels",
])

/** Params that escalate an otherwise read/internal tool to EXTERNAL when truthy. */
const ESCALATING_FLAGS = ["apply_changes", "send_email", "save_to_drive", "send", "email_client", "notify_client"]

// Verbs matched as whole name SEGMENTS (split on "_"), so "catalog" never matches
// the "log" write-verb and "crm_search_x" is recognized as a read even though the
// domain prefix comes first. A name's tier is decided by the strongest verb present:
// EXTERNAL > WRITE_INTERNAL > READ.
const READ_VERBS = new Set([
  "search", "get", "list", "read", "find", "view", "lookup", "pipeline", "tracker",
  "stats", "inbox", "status", "summary", "dashboard", "availability", "history",
  "upcoming", "report", "preview", "info", "details", "pnl", "ocr", "review",
])
const EXTERNAL_VERBS = new Set([
  "send", "resend", "deactivate", "reactivate", "delete", "payout", "confirm",
  "submit", "charge", "refund",
])
const WRITE_VERBS = new Set([
  "create", "update", "add", "save", "upload", "move", "rename", "process",
  "recategorize", "mark", "claim", "release", "reply", "sync", "prepare", "set",
  "advance", "decide", "draft", "log", "complete", "transition", "reactivate",
])

function isTruthyFlag(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1"
}

/**
 * Classify a tool call into a risk tier. Order matters: param-escalation and
 * curated overrides win over naming; naming is the fallback; unknown → EXTERNAL.
 */
export function classifyTool(name: string, params: Record<string, unknown> = {}): { tier: RiskTier; reasons: string[] } {
  const reasons: string[] = []
  const lower = name.toLowerCase()

  // 1. Parameter-aware escalation (a "review"/"prepare" tool that applies/sends).
  for (const f of ESCALATING_FLAGS) {
    if (f in params && isTruthyFlag(params[f])) {
      reasons.push(`param ${f}=true → escalate`)
      return { tier: "EXTERNAL", reasons }
    }
  }

  // 2. Curated overrides (strongest signal).
  if (EXTERNAL_TOOLS.has(name)) { reasons.push("curated EXTERNAL"); return { tier: "EXTERNAL", reasons } }
  if (READ_TOOLS.has(name)) { reasons.push("curated READ"); return { tier: "READ", reasons } }

  // 3. Segment-based naming: strongest verb present wins (EXTERNAL > WRITE > READ).
  const segs = lower.split("_")
  if (segs.some((s) => EXTERNAL_VERBS.has(s))) { reasons.push("name: external verb"); return { tier: "EXTERNAL", reasons } }
  if (segs.some((s) => WRITE_VERBS.has(s))) { reasons.push("name: write verb"); return { tier: "WRITE_INTERNAL", reasons } }
  if (segs.some((s) => READ_VERBS.has(s))) { reasons.push("name: read verb"); return { tier: "READ", reasons } }

  // 4. Fail-safe: anything not confidently READ requires approval.
  reasons.push("unclassified → FAIL-SAFE EXTERNAL")
  return { tier: "EXTERNAL", reasons }
}

export interface PolicyConfig {
  /** When true, low-stakes internal mutations run without approval. Default false (ask). */
  writeInternalAuto?: boolean
}

/** Final decision for a tool call: auto-run, queue-for-approval, or block. */
export function decideAction(
  name: string,
  params: Record<string, unknown> = {},
  config: PolicyConfig = {},
): { decision: ToolDecision; tier: RiskTier; reasons: string[] } {
  if (HARD_BLOCKED_TOOLS.has(name)) {
    return { decision: "blocked", tier: "EXTERNAL", reasons: ["hard-blocked tool"] }
  }
  const { tier, reasons } = classifyTool(name, params)
  if (tier === "READ") return { decision: "auto", tier, reasons }
  if (tier === "WRITE_INTERNAL") return { decision: config.writeInternalAuto ? "auto" : "approval", tier, reasons }
  return { decision: "approval", tier, reasons }
}
