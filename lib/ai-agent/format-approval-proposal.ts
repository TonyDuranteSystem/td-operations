/**
 * Approval proposal formatter — Hermes ↔ Claude bridge (Phase 2, Slice 4).
 *
 * A PURE, DB-FREE function that renders an `approval_queue` row into a
 * human-readable, mobile-friendly Telegram message. Hermes (running on the Mac
 * Mini) calls `approval_list` to fetch pending proposals, then uses this format
 * to present each one to Antonio with the exact action, key params, risk flags,
 * rationale, and the APPROVE/REJECT instructions.
 *
 * WHY a shared formatter (vs Hermes formatting its own): the risk surfacing —
 * which params Antonio MUST see, and which actions are external/cascading/
 * irreversible — is defined ONCE in `approvable-tools.ts`
 * (APPROVABLE_TOOL_CONSTRAINTS). Formatting here keeps the proposal card in lock
 * step with that single source of truth, so adding a tool / flag automatically
 * flows into the message Antonio reads. It also keeps the same surfacing rule
 * the eventual `/portal/team/approvals` card will use.
 *
 * Pure + DB-free → trivially unit-testable, and safe to import anywhere.
 *
 * SAFETY: this only FORMATS. It never approves, never executes. The MANDATORY
 * discipline (show Antonio the full proposal, wait for explicit OK before
 * approval_decide(approve)) lives in the MCP tool description + Hermes's USER.md.
 */

import { APPROVABLE_TOOL_CONSTRAINTS } from "./approvable-tools"

/**
 * The subset of an `approval_queue` row this formatter reads. Matches the
 * columns written at propose time (lib/ai-agent/approvable-tools.ts +
 * the propose_action worker tool). Extra columns on the real row are ignored.
 */
export interface ApprovalProposalRow {
  id: string
  tool_name: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any> | null
  rationale?: string | null
}

/** Max chars shown for a single param value before truncation (mobile-friendly). */
const MAX_VALUE_LEN = 240

/** First 8 chars of the UUID — the short id Antonio types in APPROVE/REJECT. */
export function shortId(id: string): string {
  return (id ?? "").slice(0, 8)
}

/**
 * Render one param value for display. Strings pass through (truncated); scalars
 * stringify; objects/arrays JSON-stringify (truncated). Long values get an
 * ellipsis so a 20k-char email body doesn't blow up the Telegram message.
 */
function formatValue(value: unknown): string {
  let str: string
  if (typeof value === "string") {
    str = value
  } else if (typeof value === "number" || typeof value === "boolean") {
    str = String(value)
  } else {
    try {
      str = JSON.stringify(value)
    } catch {
      str = String(value)
    }
  }
  // Collapse newlines so a multi-line body stays on one indented line.
  str = str.replace(/\s*\n\s*/g, " ").trim()
  if (str.length > MAX_VALUE_LEN) {
    str = str.slice(0, MAX_VALUE_LEN) + "…"
  }
  return str
}

/**
 * Build the risk-flag line from a tool's constraints. Returns the human labels
 * for whichever flags are set, joined with " / ", or null if none.
 */
function riskFlags(toolName: string): string | null {
  const c = APPROVABLE_TOOL_CONSTRAINTS[toolName]
  if (!c) return null
  const flags: string[] = []
  if (c.external) flags.push("External recipient")
  if (c.cascades) flags.push("Cascades")
  if (c.irreversible) flags.push("Irreversible")
  return flags.length > 0 ? flags.join(" / ") : null
}

/**
 * Format an approval_queue row into a plain-text Telegram message.
 *
 * Layout (sections separated by blank lines; sections with no content are
 * omitted entirely so the message stays tight on mobile):
 *
 *   📋 Action Proposal #<short-id>
 *
 *   🔧 <Tool Label>
 *      <key>: <value>   (one line per SURFACED param that is present)
 *
 *   ⚠️ <risk flags>      (only if the tool has any)
 *
 *   💡 <rationale>       (only if present)
 *
 *   To approve: APPROVE <short-id>
 *   To reject: REJECT <short-id> <reason>
 *
 * Missing/unknown data is handled gracefully:
 *   - Unknown tool (not in constraints) → label falls back to the raw tool_name
 *     and ALL params are surfaced (we can't know which matter, so show them).
 *   - Surfaced params absent from `params` are simply skipped.
 *   - Null/empty params → a "(no parameters)" placeholder so the card isn't blank.
 */
export function formatApprovalProposal(row: ApprovalProposalRow): string {
  const sid = shortId(row.id)
  const constraint = APPROVABLE_TOOL_CONSTRAINTS[row.tool_name]
  const label = constraint?.label ?? row.tool_name
  const params = row.params ?? {}

  // Which keys to surface: the curated `surface` list for known tools; for an
  // unknown tool we can't know which matter, so surface every provided key.
  const surfaceKeys = constraint?.surface ?? Object.keys(params)

  const paramLines: string[] = []
  for (const key of surfaceKeys) {
    const value = (params as Record<string, unknown>)[key]
    if (value === undefined || value === null) continue
    paramLines.push(`   ${key}: ${formatValue(value)}`)
  }

  const sections: string[] = []

  // Header.
  sections.push(`📋 Action Proposal #${sid}`)

  // Tool + surfaced params.
  const toolBlock = [`🔧 ${label}`]
  if (paramLines.length > 0) {
    toolBlock.push(...paramLines)
  } else {
    toolBlock.push("   (no parameters)")
  }
  sections.push(toolBlock.join("\n"))

  // Risk flags (only if any).
  const flags = riskFlags(row.tool_name)
  if (flags) {
    sections.push(`⚠️ ${flags}`)
  }

  // Rationale (only if present and non-empty).
  const rationale = (row.rationale ?? "").trim()
  if (rationale) {
    sections.push(`💡 ${rationale}`)
  }

  // Decision instructions.
  sections.push([`To approve: APPROVE ${sid}`, `To reject: REJECT ${sid} <reason>`].join("\n"))

  return sections.join("\n\n")
}
