/**
 * ANSWER GUARDS — the deterministic floor under two prompt rules that have now
 * failed four times (dev job a6c3d75b, council 2026-07-18).
 *
 * The prompt ALREADY says, verbatim: "Before telling Antonio you can't do something,
 * or that a tool or thing 'doesn't exist', CHECK first" and "When Antonio pushes back
 * or corrects you… Assume YOU may be wrong: re-check with a DIFFERENT tool". Those
 * lines were live during the AI Venture Labs incident and were ignored. The repo's
 * own worker test file is a changelog of this same class being patched with prompt
 * text three times before. So this is NOT another instruction — it is a check the
 * SERVER performs on the answer before it ships.
 *
 * The design that makes it work (and not be gameable):
 *   • the TEXT pattern is only the TRIGGER — cheap, and it can drift;
 *   • the actual GATE is the TOOL TRACE, which the server owns and the model
 *     cannot fabricate. A grounded negative ("I searched documents, Drive and the
 *     activity log and found nothing") passes automatically, because the evidence
 *     is really there.
 *   • it NUDGES (one extra loop iteration) rather than blocking. A gate that
 *     silently eats replies would be worse than the bug.
 *
 * Modeled line-for-line on the proven language guard in worker-tools.ts, which
 * exists for the same reason: a prompt rule that failed twice needed a floor.
 *
 * Pure + dependency-free so it is trivially unit-testable.
 */

/**
 * Lookups that COUNT as having actually searched before claiming something is
 * absent. Deliberately broad — any real attempt to look counts; the guard is
 * aimed at answering from belief with ZERO lookups, not at grading search quality.
 */
export const ABSENCE_EVIDENCE_TOOLS = new Set([
  // the two places the AI Venture Labs answer lived and never checked
  "run_sql_query", "crm_query",
  "doc_search", "doc_get", "doc_list", "search_documents", "get_document",
  // the activity trail — "when did we do X" lives here
  "get_client_history",
  // paperwork / client state
  "get_client_paperwork", "get_client_360", "get_account_detail",
  // files
  "drive_search", "drive_list_folder", "read_drive_file", "docai_ocr_file",
  "read_scanned_document",
  "read_portal_attachment", "read_email_attachment",
  // correspondence + history
  "gmail_search", "gmail_read", "gmail_read_thread",
  "search_conversations", "portal_chat_read", "portal_chat_inbox",
  "search_portal_messages", "recall_conversation", "recall_thread",
  // the catalog escape hatch — if it went looking there, it looked
  "use_tool", "find_tool",
  // named searches
  "search_accounts", "search_contacts", "search_deals", "search_leads",
  "search_payments", "search_services", "search_tasks", "search_deadlines",
  "search_tax_returns", "search_kb", "search_sysdocs", "get_sop", "search_templates",
])

/** True when at least one real lookup ran this turn. */
export function hasSearchedForAbsence(toolsUsed: readonly string[]): boolean {
  return (toolsUsed ?? []).some((t) => ABSENCE_EVIDENCE_TOOLS.has(t))
}

/**
 * A lookup that FAILED is not evidence of absence — it is evidence of nothing.
 *
 * This is not hypothetical: the audit trail of the AI Venture Labs incident shows
 * the worker DID query, twice, at 15:33 and 15:34 — for tables named
 * `ss4_fax_history` and `fax_history`. Neither exists. Both queries errored, and
 * from "the table I guessed isn't there" it concluded "there is no fax data in the
 * database" and told Antonio to go look it up himself. It never checked which
 * tables DO exist, and never opened documents or the activity log.
 *
 * So counting any executed lookup as proof-of-search would make the guard useless
 * for the very incident it exists to prevent. Only a lookup that came back WITHOUT
 * an error counts.
 */
const FAILED_LOOKUP_PATTERNS: RegExp[] = [
  /\bdoes\s+not\s+exist\b/i,          // Postgres: relation "fax_history" does not exist
  /\brelation\b[^\n]{0,40}\bdoes\s*n[o']?t\s+exist\b/i,
  /\bundefined_table\b|\bundefined_column\b/i,
  /\bsyntax\s+error\b/i,
  /\bpermission\s+denied\b/i,
  /^\s*❌/,
  /"?\berror\b"?\s*[:=]/i,
  /\bSQL\s+Error\b/i,
  /\blookup_failed"?\s*:\s*true\b/i,
  /\bquery\s+failed\b/i,
  /\bis\s+blocked\b|\bnot\s+permitted\b/i,
]

/** True when a tool result reads as a failure rather than a real answer. Pure. */
export function looksLikeFailedLookup(result: unknown): boolean {
  const text = typeof result === "string" ? result : String(result ?? "")
  if (!text.trim()) return false
  // Only inspect the head — a long successful payload can legitimately contain the
  // word "error" deep inside client data.
  const head = text.slice(0, 600)
  return FAILED_LOOKUP_PATTERNS.some((re) => re.test(head))
}

/**
 * Literal shapes of "it isn't there / I can't get it / go look yourself". Built
 * from the REAL incident replies, not invented. Kept narrow enough that ordinary
 * answers don't trip it — and remember a trip only matters when zero lookups ran.
 */
const ABSENCE_PATTERNS: RegExp[] = [
  // "there's no dedicated fax table in the database" / "no fax table exists"
  /\bno\b[^.!?]{0,40}\b(table|record|records|entry|entries|row|rows|data)\b[^.!?]{0,30}\b(exist|exists|in the (database|system)|found)\b/i,
  /\bthere(?:'s| is| are)\s+no\b[^.!?]{0,40}\b(table|record|records|entry|entries|data|log)\b/i,
  // "isn't stored here" / "is not recorded in the database" / "not tracked"
  /\b(is|are|isn'?t|aren'?t|is not|are not|not)\b[^.!?]{0,20}\b(stored|recorded|saved|tracked|logged)\b/i,
  // "not in the database" / "not in our system"
  /\bnot\s+(?:in|available in)\s+(?:the|our)\s+(database|system|crm)\b/i,
  // "doesn't exist" / "does not exist"
  /\bdoes\s*n[o']?t\s+exist\b/i,
  // "you'll need to check it manually / yourself / directly in ..."
  /\b(you'?ll|you)\s+(?:need to|have to|will need to|should)\s+check\b[^.!?]{0,40}\b(manually|yourself|directly|in\s+\w+)/i,
  // "I don't have access to"
  /\bI\s+do\s*n[o']?t\s+have\s+access\s+to\b/i,
  // "no record of" / "there is no record"
  /\bno\s+record\s+of\b/i,
  // "isn't available" / "not available in"
  /\b(is|it'?s|that'?s)\s*n[o']?t\s+available\b/i,
  // "couldn't find any ... in the database/system"
  /\b(could\s*n[o']?t|can\s*n[o']?t|unable to)\s+(find|locate|retrieve)\b/i,
]

/**
 * True when the draft reply tells the reader something is absent / unavailable /
 * "go look it up yourself". Pure; never throws.
 */
export function assertsAbsence(reply: string): boolean {
  const text = (reply ?? "").trim()
  if (!text) return false
  return ABSENCE_PATTERNS.some((re) => re.test(text))
}

/** Shapes of a human pushing back on the worker's previous answer. */
const CORRECTION_PATTERNS: RegExp[] = [
  /\bI\s+do\s*n[o']?t\s+think\b/i,
  /\bare\s+you\s+sure\b/i,
  /\bthat'?s\s+(not\s+right|wrong|incorrect|not\s+true)\b/i,
  /\bthat\s+is\s+(not\s+right|wrong|incorrect|not\s+true)\b/i,
  /\byou'?re\s+wrong\b/i,
  /\b(it'?s|that'?s)\s+not\s+(correct|right)\b/i,
  /\bcheck\s+again\b/i,
  /\bno,?\s+(it|that|he|she|they|we|the)\b/i,
  // the incident's own phrasing: "plus you have to check the sent date in fax history"
  /\byou\s+(?:have\s+to|need\s+to|must)\s+check\b/i,
  /\bwrong\b/i,
]

/**
 * True when the staff member's message reads as a correction of the worker's
 * previous answer. Used to force a FRESH lookup before the worker is allowed to
 * reply — which is what makes "the database and the screenshot both agree"
 * structurally impossible rather than merely forbidden.
 */
export function isCorrection(staffMessage: string): boolean {
  const text = (staffMessage ?? "").trim()
  if (!text) return false
  return CORRECTION_PATTERNS.some((re) => re.test(text))
}

/** The nudge appended when an absence claim has no lookup behind it. */
export function buildAbsenceNudge(): string {
  return [
    "STOP — you are about to tell the staff member that something is not in the system,",
    "but you have not run a single lookup this turn.",
    "",
    "Search before you answer. The places people forget, in order:",
    "  1. the client's stored DOCUMENTS (a receipt/confirmation is filed as a document);",
    "  2. the ACTIVITY LOG / audit history (it records what was done and when — faxes,",
    "     stage changes, uploads, sends);",
    "  3. Google Drive;",
    "  4. a direct database query — and if you are unsure a table exists, LOOK IT UP",
    "     in the schema rather than asserting it doesn't.",
    "",
    "Then answer. If it genuinely is not there, say exactly where you looked.",
    "Never say a table, record or feature 'doesn't exist' without having checked.",
  ].join("\n")
}

/** The nudge appended when the human corrected the worker and it re-answered blind. */
export function buildCorrectionNudge(): string {
  return [
    "STOP — the staff member just corrected you, and you are about to reply without",
    "checking anything. Assume YOU are wrong: they are usually right about their own",
    "business.",
    "",
    "Run a FRESH lookup with a DIFFERENT source than the one you used before —",
    "the activity log is often where the correction is recorded (e.g. a field that was",
    "changed, by whom, and when).",
    "",
    "Never claim a source 'agrees' with you unless you just read it this turn.",
    "If you cannot verify, say so plainly and accept the correction.",
  ].join("\n")
}
