/**
 * Tool risk classifier + policy — the SAFETY CORE of the flexible action surface.
 *
 * Decides whether the assistant may run a catalog tool by itself, must ask a human
 * first, or may never run it at all.
 *
 * ── HOW THIS WORKS, AND WHY IT WAS REWRITTEN ────────────────────────────────────
 *
 * This used to GUESS from the tool's NAME: a name segment like "get"/"list"/"read"/
 * "review" meant READ, and READ meant auto-run with nobody watching. Run against the
 * real 216-tool catalog that auto-approved 106 tools, including:
 *   · tax_extension_list      — emails a CSV of EVERY client's company name + EIN to
 *                               a model-chosen address (a "list" that sends)
 *   · sysdoc_read             — reads any system doc INCLUDING platform credentials
 *   · signature_request_get   — returns a link that signs a legal document AS the client
 *   · gmail_read_attachment   — opens an attachment in ANY mailbox and writes to Drive
 *   · lead_search / lead_get  — return offer links that sign a contract
 *   · msg_list_channels       — returns messaging provider config (credentials)
 *   · bank_statement_pnl      — hand-curated as safe, yet overwrites the client's
 *                               filed P&L because upload_to_drive DEFAULTS TRUE
 *
 * The naming heuristic is GONE. This is now a positive allow-list: a tool is
 * auto-runnable ONLY if a human read its handler and listed it below. Everything else
 * — including every tool added in the future — requires approval by default. Adding a
 * tool to the catalog can no longer silently grant it unsupervised access.
 *
 * ── THE TWO QUESTIONS ASKED OF EVERY TOOL ───────────────────────────────────────
 * A tool is SAFE only if it passes BOTH:
 *   1. Does it CHANGE anything? — inserts/updates/deletes, file writes, external API
 *      calls, emails, status changes. Including via parameters that DEFAULT TO TRUE
 *      (the model never passes them, so they fire silently) and INVERTED flags like
 *      `dry_run` that mean "do it for real" when absent.
 *   2. Does what it RETURNS carry anything dangerous, even if it changes nothing? —
 *      credentials, bearer links (signing/payment/magic URLs that grant access by
 *      possession), another client's records, or bulk tax IDs and bank details.
 * Question 2 is the one a mutation-focused review misses: three of the worst cases
 * above change nothing at all. They just hand back something that shouldn't leave.
 *
 * ── MAINTAINING THIS ────────────────────────────────────────────────────────────
 * tests/unit/tool-risk-catalog.test.ts enumerates the REGISTERED catalog and fails the
 * build when a tool appears that no human has classified. Do not silence it by adding
 * names to READ_TOOLS — read the handler first, both questions, then decide.
 */

export type RiskTier = "READ" | "WRITE_INTERNAL" | "EXTERNAL"
export type ToolDecision = "auto" | "approval" | "blocked"

/**
 * Tools the assistant may NEVER invoke, at any tier, with any approval.
 *
 * Two families: raw SQL / test scaffolding (arbitrary or destructive by construction),
 * and cross-account MASS writers — one call touching every account, where a mistake is
 * not one wrong record but the whole book, and no per-item approval is possible.
 */
export const HARD_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  // Arbitrary execution
  "execute_sql", // raw production SQL, incl. write mode and DDL
  "crm_query", // raw SQL via the read-only RPC — still arbitrary SQL
  // Test scaffolding against the live database
  "test_setup",
  "test_cleanup",
  // Cross-account mass mutation — unbounded blast radius, no meaningful approval unit
  "crm_sync_airtable", // pushes every account to an external base
  "doc_map_folders", // rewrites every orphan document row
  "doc_mass_process", // OCR + document writes across ALL accounts
  "doc_update_health", // overwrites client_health on every active account
  "hc_sync_license_deadlines", // writes deadlines for every linked company
  "portal_transition_batch", // full portal cascade + auto-sends welcome email per client
  // Irreversible destruction
  "storage_delete", // mass file removal, no dry-run, Drive mirror left orphaned
  "whop_delete_product", // permanent external delete; dry_run has NO default → deletes
])

/**
 * Sends that must NEVER fire from a queued approval (dev job a6c3d75b, council
 * Security + Senior Engineer, 2026-07-18). Two rationales, one guard:
 *
 * 1. PIN-SKIPPING. The worker's own send path enforces "only addresses on this
 *    thread" / "only the client whose chat is open" (checkRecipientsAllowed + the
 *    pinned portal recipient). The approval executor does NOT go through that path
 *    — it dispatches straight to the tool by name with params frozen at propose
 *    time. So an approved send would run with whatever recipient the MODEL chose,
 *    silently skipping the strongest control on a surface that reads mail written
 *    by strangers.
 *
 * 2. IRREVERSIBLE CLIENT-FACING DOCUMENTS. Offers, leases, operating agreements,
 *    ITIN forms, invoices and the accountant hand-off all go to a real person and
 *    cannot be recalled. Firing one from a queue — where the payload was frozen
 *    minutes or hours earlier and nothing re-verifies the recipient — is the same
 *    risk in a different shape.
 *
 * Blocking these costs nothing today: the rail is off, and the worker already
 * sends through its pinned path on the staff member's explicit "go", which shows
 * the draft and cannot be redirected.
 *
 * IF approved sends are ever wanted, the fix is NOT to relax this — it is to freeze
 * the ALLOWED RECIPIENTS into the proposal at propose time and re-verify them at
 * execute time. Until that exists, this list is the guarantee. A test asserts that
 * every curated EXTERNAL tool whose name contains "send" appears here, so a new one
 * cannot be added without either protecting it or consciously excluding it.
 */
export const NO_APPROVAL_SEND_TOOLS: ReadonlySet<string> = new Set([
  // EVERY email is confirmed on a card (Antonio, 2026-07-29), and that gate lives
  // in the worker's send path. The approval executor dispatches by tool name
  // straight to the raw implementation, so an approved `send_email` would leave
  // with no frozen payload, no card and no recipient check — the one hole in
  // "every email has a card". Dormant today (the action rail is off) but listed
  // here so switching the rail on can never silently open it.
  "send_email",
  // per-call recipient pin lives only on the worker's send path
  "gmail_send",
  "portal_chat_send",
  "portal_team_send",
  "team_chat_send",
  "msg_send",
  "agent_msg_send",
  // irreversible client-facing document sends
  "offer_send",
  "lease_send",
  "oa_send",
  "itin_form_send",
  "portal_invoice_send",
  "tax_send_to_accountant",
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
 * THE ALLOW-LIST — the only tools that may run without a human being asked.
 *
 * Every entry was classified by reading its handler (2026-07-19, full 216-tool sweep)
 * against BOTH questions: does it change anything (including via default-true and
 * inverted flags), and does its OUTPUT carry credentials, bearer links, another
 * client's records, or bulk tax IDs. 57 of 216 tools passed. Anything absent from this
 * set requires approval — that is the fail-safe, and it is the whole design.
 *
 * NOTABLY ABSENT, and why — these were auto-run under the old name-guessing:
 *   bank_statement_pnl     upload_to_drive DEFAULTS TRUE → overwrites the client's P&L
 *   sysdoc_read            no agent_readable gate, no redaction; reads credentials
 *   signature_request_get  returns a link that signs a legal document as the client
 *   docai_ocr_file         OCRs any Drive file by id → passports, tax returns
 *   gmail_labels           as_user enumerates ANY mailbox, incl. the owner's personal
 *   classify_document      billed OCR of an arbitrary file + raw content preview
 *   crm_search_contacts    select(*) → ITIN, DOB, passport, in bulk
 *   crm_search_payments    select(*) → pay_token, a live bearer payment link
 *   lead_search / lead_get return offer_link, a contract-signing bearer URL
 *   doc_get                prints raw OCR text of passports and tax returns
 *   msg_list_channels      returns messaging provider config (credentials)
 *   kb_get                 looks like a read; bumps a usage counter (a write)
 *
 * ADDING TO THIS LIST IS A SECURITY DECISION. Read the handler, answer both questions,
 * and say in the comment why it is safe — not what it is called.
 */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  // — CRM reads that return operational state, no identity documents or tokens —
  "crm_search_services", "crm_search_tasks", "crm_search_deals", "crm_dashboard_stats",
  "task_tracker", "sd_search", "sd_pipeline", "audit_crm", "cron_status",
  "conv_search", "deadline_search", "deadline_upcoming",
  // — Internal knowledge / procedure text, no client PII —
  "kb_search", "sop_search", "sop_get", "sysdoc_list", "sysdoc_read_allowed",
  // sysdoc_read_allowed is the HARDENED sibling of sysdoc_read: agent_readable filter,
  // fails closed hiding existence, and pipes the body through redactSensitive().
  // — Document METADATA only; the tools that return bodies or OCR text are excluded —
  "doc_search", "doc_list", "doc_stats", "doc_compliance_check", "doc_compliance_report",
  "drive_search", "drive_list_folder", "drive_get_file_info",
  // — Messaging reads: conversation text, no provider config, no attachment URLs —
  "msg_inbox", "msg_read_group", "msg_search", "portal_chat_inbox",
  // portal_chat_inbox returns previews only; portal_chat_read is excluded because it
  // renders client attachment URLs.
  // — Pipeline / commercial reads with no tokens in the selected columns —
  "lease_list", "offer_list", "referral_search", "referral_tracker",
  "tax_search", "tax_tracker",
  // lease_list and offer_list omit access_code from their select lists; the *_get
  // siblings return signing links and are excluded.
  // — Calendar / scheduling: own calendar, metadata only —
  "calendar_list_events", "calendar_find_free_slots", "cal_list_bookings", "cal_get_availability",
  // cal_get_event_details is excluded — it returns invitee PII and a reschedule URL.
  // — Meeting metadata only; cb_get_call and cb_search_calls return transcripts and a
  //   recording URL, so they are excluded —
  "cb_list_calls",
  // — External vendor reads with no PII —
  "hc_list_companies", "hc_get_order", "hc_list_deliveries", "hc_list_licenses",
  "whop_list_plans", "whop_list_products",
  // whop_list_payments and whop_list_memberships are excluded — bulk customer email,
  // card brand/last4 and billing addresses.
  // — Vocabulary catalog, read side only; catalog_update and catalog_pending mutate —
  "catalog_list",
  // — Produces a document FOR THE STAFF MEMBER and returns a private, expiring link.
  //   Writes only to the scratch bucket the panels already use; nothing client-visible,
  //   nothing sent, no client record touched. Filing the result to Drive or a client
  //   record is a SEPARATE tool and stays behind approval. Requiring a confirmation to
  //   turn text you just asked for into a PDF would make the feature pointless.
  "pdf_create",
  // — Pure computation, no I/O —
  "classify_text", "classify_list_rules",
  // — Internal engineering surfaces, repo-scoped and secret-blocked —
  "codebase_read", "codebase_search", "job_status", "job_list", "work_list",
  "dev_task_list", "thread_search", "storage_list",
  // storage_list returns names and sizes; storage_read returns file bodies and is excluded.
])

/**
 * Params that escalate an otherwise read/internal tool to EXTERNAL when truthy.
 *
 * COUNCIL FIX (2026-07-18, dev job a6c3d75b): `mark_reviewed` was missing, so
 * `closure_form_review({ mark_reviewed: true })` classified as READ — the name
 * segment "review" is a READ verb — and AUTO-RAN an unapproved write (it sets
 * status/reviewed_at/reviewed_by). Any tool whose write is gated behind a boolean
 * MUST have that boolean listed here, or the read-verb heuristic silently wins.
 * Added the observed sibling shapes too (mark_ prefixed flags, plus confirm,
 * approve, execute, apply, publish, finalize) so the next tool named "…_review"
 * or "…_status" that mutates on a flag is caught by default rather than by luck.
 */
const ESCALATING_FLAGS = [
  "apply_changes", "send_email", "save_to_drive", "send", "email_client", "notify_client",
  "mark_reviewed", "mark_complete", "mark_sent", "mark_paid",
  "confirm", "confirm_resend", "approve", "execute", "apply", "publish", "finalize",
]

/**
 * Is this escalating flag actually SET to something meaningful?
 *
 * Was `v === true || "true" || 1 || "1"`, which missed the real shapes entirely: the
 * dangerous values in this catalog are STRINGS — `send_to_email: "x@y.com"`,
 * `save_to_drive_folder_id: "1AbC..."`. A present, non-empty value of ANY type means
 * the caller asked for the behaviour, so treat it as set. Explicit false/""/0 does not
 * count, since that is the caller switching the behaviour OFF.
 */
function isFlagSet(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (v === false || v === "false" || v === 0 || v === "0" || v === "") return false
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * Does this param name look like one of the escalating flags?
 *
 * Was an EXACT key match, so the list's `send_email` never matched the real param
 * `send_to_email`, and `save_to_drive` never matched `save_to_drive_folder_id`. Both
 * of those are live sending/writing switches. Substring matching in either direction
 * catches the real names without needing to enumerate every suffix.
 */
function matchesEscalatingFlag(paramName: string): string | null {
  const k = paramName.toLowerCase()
  for (const f of ESCALATING_FLAGS) {
    if (k === f || k.includes(f) || f.includes(k)) return f
  }
  return null
}

/**
 * Classify a tool call into a risk tier.
 *
 * There is NO name-based guessing any more. A tool is auto-runnable only by appearing
 * in READ_TOOLS, which means a human read its handler. Everything else needs approval.
 */
export function classifyTool(name: string, params: Record<string, unknown> = {}): { tier: RiskTier; reasons: string[] } {
  const reasons: string[] = []

  // 1. Curated EXTERNAL wins outright — never downgraded by anything below.
  if (EXTERNAL_TOOLS.has(name)) { reasons.push("curated EXTERNAL"); return { tier: "EXTERNAL", reasons } }

  // 2. Parameter escalation. Defence in depth for the allow-list: a tool that is safe
  //    when read is NOT safe when called with a flag that makes it send or write. Note
  //    this only sees what the CALLER passed — a schema default that is dangerous when
  //    omitted is invisible here, which is exactly why such tools (bank_statement_pnl)
  //    are kept off the allow-list entirely rather than relied on being caught here.
  for (const [key, value] of Object.entries(params)) {
    if (!isFlagSet(value)) continue
    const flag = matchesEscalatingFlag(key)
    if (flag) {
      reasons.push(`param ${key} is set → escalate (matches "${flag}")`)
      return { tier: "EXTERNAL", reasons }
    }
  }

  // 3. The allow-list — the ONLY route to auto-run.
  if (READ_TOOLS.has(name)) { reasons.push("on the reviewed read allow-list"); return { tier: "READ", reasons } }

  // 4. Everything else, including every newly added tool, asks first.
  reasons.push("not on the reviewed allow-list → approval required")
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
