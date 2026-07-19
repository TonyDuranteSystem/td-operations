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
  "read_slack_link",
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
 * A PARTIAL read is not evidence of absence either — and unlike a failed lookup,
 * it arrives looking like a success.
 *
 * Google Document AI refuses a document over 15 pages in one call, so a long
 * scan (a filed tax return, typically 30-50 pages) is read a WINDOW at a time.
 * Reading pages 1-15 of a 35-page return succeeds cleanly: no error, no
 * `lookup_failed`. Without this check `hasSearchedForAbsence` would be fully
 * satisfied by 43% of the document, and the assistant could state "there is no
 * Schedule C in this return" — with the guard affirmatively confirming it had
 * looked — when Schedule C is on page 22.
 *
 * That is strictly worse than the wholesale failure it replaced: today's failure
 * is correctly counted as "did not look". So a read that reports incomplete
 * coverage must NOT count as a completed search.
 *
 * Keyed on the machine-readable coverage contract from `lib/docai-windows.ts`
 * (`"complete": false`), never on prose — the header of this file records what
 * happens when we rely on the model heeding an instruction.
 */
const INCOMPLETE_READ_PATTERNS: RegExp[] = [
  /"?\bcomplete"?\s*:\s*false\b/i,
  /\bINCOMPLETE READ\b/,
  /"?\bpartial_read"?\s*:\s*true\b/i,
]

/**
 * True when a tool result reports that it returned only PART of a document.
 * Pure. Scans the head only, like `looksLikeFailedLookup` — the coverage record
 * is emitted at the top of the payload precisely so this stays cheap and exact.
 */
export function looksLikeIncompleteRead(result: unknown): boolean {
  const text = typeof result === "string" ? result : String(result ?? "")
  if (!text.trim()) return false
  const head = text.slice(0, 600)
  return INCOMPLETE_READ_PATTERNS.some((re) => re.test(head))
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


/**
 * CAPABILITY REFUSALS — "I can't do this at all", as distinct from "the data isn't
 * there". This is the second thing worth a #td-worker-bug thread: no correction
 * Antonio makes can teach the worker a capability it does not have. His live
 * example (2026-07-18): "I can't access external URLs or Slack links directly — I
 * don't have a browser or Slack API access." That needed a tool built, not a lesson.
 *
 * Deliberately narrow — it must match a refusal of the WORKER'S OWN ability, not a
 * statement about the business ("the client can't sign until…"). Pure; never throws.
 */
const CANNOT_DO_PATTERNS: RegExp[] = [
  /\bI\s+(?:can\s*n[o']?t|cannot)\s+(?:access|open|read|fetch|browse|reach|view|retrieve|download)\b/i,
  /\bI\s+do\s*n[o']?t\s+have\s+(?:a\s+)?(?:browser|internet|web|api|slack|access to)\b/i,
  /\bI(?:\s+am|'m)\s+(?:not\s+able|unable)\s+to\s+(?:access|open|read|fetch|browse|reach)\b/i,
  /\bno\s+(?:browser|internet access|web access|api access)\b/i,
  /\bI\s+do\s*n[o']?t\s+have\s+(?:the\s+)?(?:ability|capability|a way)\s+to\b/i,
  /\bthat'?s\s+not\s+something\s+I\s+can\s+do\b/i,
]

/**
 * True when the reply is the worker refusing on its OWN capability — a gap that
 * only code can close. Pure; never throws.
 */
export function assertsCannotDo(reply: string): boolean {
  const text = (reply ?? "").trim()
  if (!text) return false
  return CANNOT_DO_PATTERNS.some((re) => re.test(text))
}

/**
 * Shapes of the worker sending someone to a DIFFERENT surface to get an action done.
 *
 * Matches "run it from Slack", "use the Slack bot", "try the CRM instead", "from a
 * surface where the approval flow is active" and similar. Deliberately narrow: it must
 * name a destination AND be about getting something RUN there, so ordinary references
 * to Slack or the portal in an answer are not caught.
 */
const SURFACE_REDIRECT_PATTERNS: RegExp[] = [
  /\b(?:from|via|in|use|try|through)\s+(?:the\s+)?slack(?:\s+bot|\s+worker)?\b[^.]{0,60}\b(?:instead|to\s+run|approval|it'?ll\s+go|will\s+go|works?)\b/i,
  /\bslack\s+bot\b/i,
  /\b(?:a|another|different)\s+surface\s+where\b/i,
  /\b(?:run|do|try)\s+(?:it|this|that)\s+(?:from|in|on)\s+(?:the\s+)?(?:slack|team\s*chat|inbox|portal|crm|dashboard)\b/i,
  /\bwhere\s+the\s+approval\s+(?:flow|rail|mechanism)\s+is\s+(?:active|on|available|enabled)\b/i,
  /\byour\s+best\s+route\s+is\b[^.]{0,40}\b(?:slack|team\s*chat|bot)\b/i,
]

/**
 * True when the reply tells the staff member another screen or bot would run an action
 * that is switched off everywhere.
 *
 * WHY THIS IS A CODE GUARD AND NOT PROMPT TEXT (dev job 74701b48): the capability block
 * already states, in the system prompt, that this is off on every surface and names the
 * Slack bot as a thing not to suggest. The worker suggested the Slack bot anyway, on the
 * very next deploy. That is the third time in this project that a sentence in a prompt
 * failed to stop a confident false claim — the PDF download, the offer to send from a
 * screen that cannot send, and now this.
 *
 * A wrong redirect is worse than a plain refusal: the staff member spends the trip and
 * still cannot do the thing. So it is caught in the reply and the worker is made to
 * answer again, the same way an unevidenced absence claim is.
 */
export function claimsAnotherSurfaceCanAct(reply: string): boolean {
  const text = (reply ?? "").trim()
  if (!text) return false
  return SURFACE_REDIRECT_PATTERNS.some((re) => re.test(text))
}

/** The nudge appended when the worker points at another surface for a dead action. */
export function buildSurfaceRedirectNudge(): string {
  return [
    "STOP — you are about to send the staff member to another screen, chat or bot to run",
    "an action. That action is switched off on EVERY surface, so wherever you send them",
    "it will fail there too. They will spend the trip and still not have the thing done,",
    "which is worse than you simply saying no.",
    "",
    "Rewrite your answer:",
    "  · say plainly that this cannot be run by the assistant anywhere right now;",
    "  · state exactly what the action would be, with the values, so they can do it;",
    "  · do NOT name Slack, team chat, the inbox, the portal or any other surface as a",
    "    place it would work — none of them will;",
    "  · keep everything you looked up. The lookup is the useful part; only the",
    "    'go do it over there' part is wrong.",
  ].join("\n")
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
