/**
 * CODE ↔ DATABASE CONTRACT — the pure comparison.
 *
 * Asserts that every value the code can write into a CHECK-constrained column is a value
 * the database will actually accept, and that the database we check against is still the
 * one production runs.
 *
 * WHY THIS EXISTS (2026-07-14):
 *
 * The code wrote bank-feed statuses (`needs_review`, `activation_crashed`) that
 * PRODUCTION's CHECK constraint did not permit. Every write was rejected. Every error was
 * discarded. The review queue therefore never worked — for months — while the UI rendered
 * an empty "Needs Review" tab and everyone read empty as "nothing to review".
 *
 * Three reviewers and five rounds of adversarial review missed it, because all of us were
 * reading CODE against CODE. Nobody compared the code against the database it writes to. A
 * 32/32 green integration harness proved nothing: the harness's database (sandbox) had NO
 * constraints at all — strictly more permissive than production. A green run against a more
 * permissive database is not evidence.
 *
 * ── WHY THE LOGIC IS *HERE*, IN lib/, AND NOT IN THE SCRIPT ──
 *
 * Three transports need the same answer:
 *   1. the pre-push hook + CI      → against the committed snapshot (no credential)
 *   2. CI                          → against the live sandbox database
 *   3. the in-app cron             → against the live PRODUCTION database
 *
 * Three copies of a comparison would drift apart — which is, precisely, the bug this file
 * exists to prevent. One implementation, three callers, no I/O in here.
 */

import { createHash } from "node:crypto"
import { FEED_STATUSES, MATCH_CONFIDENCES, FEED_SOURCES } from "@/lib/finance/feed-vocabulary"
import { PAYMENT_CATEGORIES } from "@/lib/billing/payment-classification"
import { PAYMENT_ITEM_TYPES } from "@/lib/finance/payment-item-vocabulary"
import { TEAM_WORK_STATUSES } from "@/lib/team/workspace"
import { OA_AGREEMENT_SIGNATURE_METHODS, OA_SIGNATURE_METHODS } from "@/lib/oa/signature-vocabulary"
import { STAFF_NOTE_VISIBILITIES } from "@/lib/notes/staff-notes"

/** name → `pg_get_constraintdef()` text, exactly as Postgres prints it. */
export type ConstraintDefs = Record<string, string>

/**
 * Fingerprint a constraint set.
 *
 * Deliberately reproducible IN POSTGRES — the identical digest comes out of:
 *   md5(string_agg(conname || '|' || pg_get_constraintdef(oid), E'\n' ORDER BY conname))
 *
 * That is what makes the committed snapshot *checkable* rather than merely *claimed*: the
 * database computes the fingerprint over its own rules, we compute it over the file, and the
 * two must agree. A snapshot that was hand-typed, half-pasted, or quietly edited to make a
 * failing gate go green cannot survive this. Given the file exists precisely because we could
 * not trust code-read-against-code, it would be absurd to trust a file nobody verified.
 */
export function checksumDefs(defs: ConstraintDefs): string {
  const payload = Object.keys(defs)
    .sort()
    .map(name => `${name}|${defs[name]}`)
    .join("\n")
  return createHash("md5").update(payload, "utf8").digest("hex")
}

/**
 * Every code-side vocabulary that is backed by a database CHECK.
 *
 * Add a row here whenever you add a constrained column — and if you forget, the check FAILS
 * rather than quietly ignoring it (see `unregistered`, below). A registry that depends on
 * someone remembering to update it is a note, not a gate, and we have spent a whole day
 * learning what notes are worth.
 */
export const CONSTRAINT_CONTRACTS = [
  { table: "td_bank_feeds", column: "status", constraint: "td_bank_feeds_status_check", values: FEED_STATUSES },
  { table: "td_bank_feeds", column: "match_confidence", constraint: "td_bank_feeds_match_confidence_check", values: MATCH_CONFIDENCES },
  { table: "td_bank_feeds", column: "source", constraint: "td_bank_feeds_source_check", values: FEED_SOURCES },
  // A MONEY column. Its code-side list already promised, in a comment, to stay "in sync with
  // the CHECK constraint" — and nothing had ever verified that. It was out of sync: the
  // database and live code both used a value the list omitted. A promise in a comment is a
  // note; this is the gate.
  { table: "payments", column: "payment_category", constraint: "payments_payment_category_check", values: PAYMENT_CATEGORIES },
  // Registered 2026-07-21. Both had existed on production, unregistered, long
  // enough for the gate to be red on EVERY run — which is worse than no gate:
  // a real failure reads as "the usual one" and gets waved through. That is
  // exactly how the file's own comments say the previous gate died.
  { table: "internal_thread_state", column: "status", constraint: "internal_thread_state_status_check", values: TEAM_WORK_STATUSES },
  // A MONEY column: `fee` lines are excluded from an invoice's base amount, so
  // a value the database rejects here silently breaks a total.
  { table: "payment_items", column: "item_type", constraint: "payment_items_item_type_check", values: PAYMENT_ITEM_TYPES },
  // Registered 2026-07-27. All three reached production unregistered — surfaced the moment the
  // committed snapshot was refreshed, having been invisible while it sat stale since 07-21.
  // A rejected write on a signature column is a signature that silently does not record.
  { table: "oa_agreements", column: "signature_method", constraint: "oa_agreements_signature_method_check", values: OA_AGREEMENT_SIGNATURE_METHODS },
  { table: "oa_signatures", column: "signature_method", constraint: "oa_signatures_signature_method_check", values: OA_SIGNATURE_METHODS },
  { table: "staff_notes", column: "visibility", constraint: "staff_notes_visibility", values: STAFF_NOTE_VISIBILITIES },
] as const

/**
 * CHECK constraints that are deliberately NOT value-vocabularies — shape rules, not lists.
 * Anything else the database constrains and the code has not registered is reported.
 */
export const NOT_A_VOCABULARY = new Set([
  "payments_must_have_payer",
  "invoice_has_owner",
  "payments_bank_preference_check", // regex + enum hybrid
  "client_invoices_recurring_frequency_check",
])

/**
 * KNOWN-UNAUDITED BASELINE — frozen 2026-07-14.
 *
 * These CHECK-constrained columns exist in the database and NOTHING in the code has ever
 * been verified against them. This is the real size of the blind spot that let the review
 * queue die: places where the code could be writing a value the database rejects, and nobody
 * would know unless a caller happened to check the error.
 *
 * Frozen rather than fixed today, deliberately: auditing them is its own job, and failing
 * the build on all of them at once would simply get this gate switched off — which is
 * precisely how the last gate died.
 *
 * ⚠️ A RATCHET, NOT AN AMNESTY. Any NEW constrained column fails the check until it is
 * registered above. The list may shrink; it must never grow. When you audit one, delete it
 * from here and add a real contract.
 */
export const UNAUDITED_BASELINE = new Set([
  "_bp_new_check",
  "account_bank_balances_source_check",
  "account_location_policies_choice_check",
  "account_location_policies_loc_code_check",
  "accounts_account_type_check",
  "accounts_member_structure_check",
  "accounts_payment_gateway_check",
  "addresses_kind_check",
  "ai_delegations_status_check",
  "ai_facts_category_check",
  "ai_facts_status_check",
  "ai_messages_role_check",
  "ai_notifications_channel_check",
  "ai_notifications_priority_check",
  "ai_notifications_status_check",
  "annual_agreements_status_check",
  "audit_flags_entity_type_check",
  "audit_flags_flag_type_check",
  "audit_flags_note_required_for_na",
  "bank_categorization_rules_category_check",
  "bank_categorization_rules_direction_check",
  "bank_categorization_rules_match_type_check",
  "bank_categorization_rules_source_check",
  "bank_transactions_ai_lean_check",
  "bank_transactions_category_check",
  "bank_transactions_loc_confidence_check",
  "bank_transactions_loc_source_check",
  "banking_submissions_language_check",
  "banking_submissions_status_check",
  "billing_entities_currency_check",
  "billing_entities_entity_type_check",
  "catalog_decision_log_action_check",
  "catalog_decision_log_actor_kind_check",
  "catalog_entries_status_check",
  "catalog_pending_review_source_check",
  "catalog_pending_review_status_check",
  "chart_of_accounts_normal_balance_check",
  "chart_of_accounts_type_check",
  "chk_account_portal_tier",
  "chk_client_invoices_status",
  "chk_contact_portal_tier",
  "chk_deadline_status",
  "chk_lease_status",
  "chk_ptm_status",
  "chk_referrals_status",
  "chk_sd_status",
  "chk_sigreq_status",
  "chk_ss4_status",
  "ck_payments_installment_transitional",
  "client_bank_accounts_currency_check",
  "client_credit_notes_status_check",
  "client_decision_requests_request_type_check",
  "client_decision_requests_status_check",
  "client_expenses_category_check",
  "client_expenses_ocr_confidence_check",
  "client_expenses_source_check",
  "client_expenses_status_check",
  "client_interactions_direction_check",
  "client_invoice_documents_direction_check",
  "client_invoice_templates_currency_check",
  "client_invoices_currency_check",
  "client_threads_source_kind_check",
  "closure_submissions_status_check",
  "coa_normal_balance_matches_type",
  "comm_conversations_created_by_type_check",
  "comm_conversations_status_check",
  "comm_messages_pinned_by_type_check",
  "comm_messages_sender_type_check",
  "comm_participants_participant_type_check",
  "contact_request_forms_form_type_check",
  "contact_request_forms_status_check",
  "contacts_gender_check",
  "contacts_portal_role_check",
  "contacts_referrer_type_check",
  "contracts_status_check",
  "conversations_direction_check",
  "cron_log_status_check",
  "dev_tasks_knowledge_status_check",
  "documents_confidence_check",
  "documents_status_check",
  "email_queue_created_by_check",
  "esign_envelopes_origin_check",
  "esign_envelopes_routing_check",
  "esign_envelopes_status_check",
  "esign_events_type_check",
  "esign_fields_type_check",
  "esign_signers_delivery_channel_check",
  "esign_signers_status_check",
  "esign_template_fields_type_check",
  "esign_templates_status_check",
  "formation_submissions_entity_type_check",
  "formation_submissions_language_check",
  "formation_submissions_status_check",
  "internal_threads_resolution_check",
  "internal_threads_thread_type_chk",
  "internal_threads_work_status_chk",
  "invoice_reminder_log_source_check",
  "itin_submissions_language_check",
  "itin_submissions_status_check",
  "job_queue_status_check",
  "journal_entries_status_check",
  "member_info_requests_status_check",
  "members_member_type_check",
  "message_actions_priority_check",
  "message_responses_sent_via_check",
  "message_responses_status_check",
  "messages_content_type_check",
  "messages_direction_check",
  "messages_status_check",
  "messaging_channels_platform_check",
  "messaging_channels_provider_check",
  "messaging_groups_group_type_check",
  "oa_agreements_status_check",
  "oa_signatures_status_check",
  "offers_payment_type_check",
  // Postgres prints a varchar column's list as `ANY ((ARRAY[...])::text[])` — note the extra
  // bracket. The tool that generated this baseline was looking for `ANY (ARRAY[`, so it missed
  // every varchar-backed vocabulary. The gate then failed on this one, which is the gate doing
  // its job: a list built by a script that quietly skipped a whole shape is the same class of
  // hole as a list nobody checked at all.
  "offers_status_check",
  "offers_payment_type_check",
  "onboarding_submissions_entity_type_check",
  "onboarding_submissions_language_check",
  "onboarding_submissions_status_check",
  "payment_links_gateway_check",
  "pending_activations_confirmation_mode_check",
  "pending_activations_status_check",
  "pnl_period_answers_actor_role_check",
  "pnl_period_answers_choice_check",
  "pnl_workspace_members_member_type_check",
  "pnl_workspaces_status_check",
  "pnl_ws_tx_loc_code_check",
  "pnl_ws_tx_loc_confidence_check",
  "pnl_ws_tx_loc_source_check",
  "portal_announcements_type_check",
  "portal_issues_status_check",
  "portal_messages_sender_context_check",
  "portal_messages_sender_type_check",
  "referral_payouts_payout_type_check",
  "referrals_commission_type_check",
  "referrals_referrer_type_check",
  "service_catalog_category_check",
  "service_catalog_default_service_context_check",
  "session_checkpoints_session_type_check",
  "statement_format_mappings_status_check",
  "system_errors_source_check",
  "system_errors_status_check",
  "task_action_log_status_check",
  "tasks_assigned_to_check",
  "tasks_created_by_check",
  "tax_quote_submissions_llc_type_check",
  "tax_quote_submissions_status_check",
  "tax_return_submissions_status_check",
  "td_comm_deliverables_type_check",
  "td_comm_disclaimers_method_check",
  "td_comm_enrollments_client_type_check",
  "td_comm_enrollments_status_check",
  "td_comm_packages_payment_timing_check",
  "td_comm_portfolio_consent_source_check",
  "td_comm_questions_audience_check",
  "td_comm_questions_type_check",
  "td_comm_showcase_consents_method_check",
  "td_expenses_category_check",
  "td_expenses_status_check",
  "wizard_progress_status_check",
  "wizard_progress_wizard_type_check",
  "worker_prepared_sends_status_check",
  "workflow_dispatch_log_outcome_check",
  "workflow_dispatch_log_trigger_source_check",
  "write_buffer_action_check",
  "write_buffer_status_check",
])

/**
 * ⚠️ WHAT THIS CHECK CANNOT SEE.
 *
 * It compares the LITERALS the code declares against the values the database permits. A
 * value COMPUTED at runtime is invisible to it — e.g. the Plaid sync used to write
 * `bankName.toLowerCase()` straight into a constrained column, which no static list can
 * catch. Those must be mapped through a helper that returns a permitted value
 * (`toFeedSource`). Do not read a green run here as proof that every write is safe; read it
 * as proof that the declared vocabularies agree.
 */

/**
 * Pull the allowed values out of a `col = ANY (ARRAY['a'::text, 'b'::text])` definition.
 * Returns [] for anything that is not a value list — a shape rule, a range, a regex.
 *
 * IT MUST ONLY READ INSIDE `ARRAY[...]`, and only when the definition is an `ANY (...)` test.
 * Scanning the whole definition for quoted literals — the obvious first implementation, and the
 * one I wrote — mistakes two other things for vocabularies:
 *
 *   CHECK ((btrim(transaction_ref) <> ''::text))   → "a list whose one allowed value is ''"
 *   CHECK ((loc_code ~ '^[A-Z]{2}$'::text))        → "a list whose one allowed value is a regex"
 *
 * Both then get reported as unregistered constrained columns, and the gate cries wolf about
 * rules it has misread. A gate that raises false alarms gets switched off, and a switched-off
 * gate is how we got here.
 */
export function parseAllowedValues(def: string): string[] {
  if (!def.includes("ANY (")) return []

  const values: string[] = []
  for (const array of Array.from(def.matchAll(/ARRAY\[([^\]]*)\]/g))) {
    for (const literal of Array.from(array[1].matchAll(/'([^']+)'::(?:text|character varying)/g))) {
      values.push(literal[1])
    }
  }
  return values
}

export type ViolationKind =
  /** The constraint the code relies on does not exist in this database at all. */
  | "constraint_missing"
  /** The code can write values this database REJECTS. This is the incident, exactly. */
  | "code_writes_rejected_values"
  /** A constrained column nobody registered — an unguarded place the same bug can grow. */
  | "constraint_unregistered"

export interface ContractViolation {
  kind: ViolationKind
  constraint: string
  table?: string
  column?: string
  /** Values the code can write that the database rejects. */
  rejectedValues?: string[]
  /** Values this database allows. */
  allowedValues?: string[]
  message: string
}

export interface ContractWarning {
  constraint: string
  table: string
  column: string
  /** The database allows these; the code never writes them. Harmless, usually a retired value. */
  unusedValues: string[]
  message: string
}

export interface ContractCheckResult {
  violations: ContractViolation[]
  warnings: ContractWarning[]
  /** Contracts that matched exactly. */
  passed: string[]
}

/**
 * Compare the code's declared vocabularies against a set of constraint definitions.
 *
 * Pure. `defs` can come from a live Postgres connection, from `exec_sql_readonly`, or from
 * the committed snapshot — the comparison must not care, or the three transports drift.
 */
export function checkDbContract(defs: ConstraintDefs): ContractCheckResult {
  const violations: ContractViolation[] = []
  const warnings: ContractWarning[] = []
  const passed: string[] = []

  for (const contract of CONSTRAINT_CONTRACTS) {
    const def = defs[contract.constraint]

    if (!def) {
      violations.push({
        kind: "constraint_missing",
        constraint: contract.constraint,
        table: contract.table,
        column: contract.column,
        message:
          `${contract.table}.${contract.column} — constraint "${contract.constraint}" DOES NOT EXIST here. ` +
          `A missing constraint is not "safe": it means this database accepts values production rejects, ` +
          `so every test that passes here proves nothing about production. That is exactly what happened.`,
      })
      continue
    }

    const allowed = parseAllowedValues(def)
    const rejected = contract.values.filter(v => !allowed.includes(v))
    const unused = allowed.filter(v => !(contract.values as readonly string[]).includes(v))

    if (rejected.length > 0) {
      violations.push({
        kind: "code_writes_rejected_values",
        constraint: contract.constraint,
        table: contract.table,
        column: contract.column,
        rejectedValues: rejected,
        allowedValues: allowed,
        message:
          `${contract.table}.${contract.column} — the code can write values this DATABASE WILL REJECT: ` +
          `${rejected.join(", ")}. These writes fail silently unless every caller checks the error. ` +
          `Add them to the CHECK via a migration.`,
      })
    }

    if (unused.length > 0) {
      warnings.push({
        constraint: contract.constraint,
        table: contract.table,
        column: contract.column,
        unusedValues: unused,
        message:
          `${contract.table}.${contract.column} — the database allows values the code never writes: ` +
          `${unused.join(", ")}. Harmless, but it usually means a value was retired in code and left in the schema.`,
      })
    }

    if (rejected.length === 0 && unused.length === 0) passed.push(contract.constraint)
  }

  // ── The registry must maintain itself ──────────────────────────────────────────────
  //
  // Every CHECK constraint that looks like a value list but no contract covers is reported.
  // Without this, "remember to register new columns" is a note — and a note is exactly what
  // failed: `needs_review` was added to the code with three UI surfaces and nobody
  // remembered the database.
  const registered = new Set<string>(CONSTRAINT_CONTRACTS.map(c => c.constraint))
  for (const [name, def] of Object.entries(defs)) {
    if (registered.has(name)) continue
    if (NOT_A_VOCABULARY.has(name)) continue
    if (UNAUDITED_BASELINE.has(name)) continue
    const allowed = parseAllowedValues(def)
    if (allowed.length === 0) continue // a shape rule, not a vocabulary

    violations.push({
      kind: "constraint_unregistered",
      constraint: name,
      allowedValues: allowed,
      message:
        `"${name}" is a NEW constrained column the code has not registered (allows: ${allowed.join(", ")}). ` +
        `Register it in CONSTRAINT_CONTRACTS with the code-side list it must match, or add it to ` +
        `NOT_A_VOCABULARY if it is a shape rule. An unregistered constrained column is a place where the ` +
        `code can write a value the database rejects — silently.`,
    })
  }

  return { violations, warnings, passed }
}

export type DriftKind = "added" | "removed" | "changed"

export interface SnapshotDrift {
  kind: DriftKind
  constraint: string
  /** What the committed snapshot says production had. */
  snapshotDef?: string
  /** What the live database says now. */
  liveDef?: string
  message: string
}

/**
 * Compare a LIVE database's constraints against the committed production snapshot.
 *
 * This is the half that `checkDbContract` structurally cannot do. The snapshot is what the
 * pre-push gate blocks against, and a snapshot is only as honest as the last time it was
 * regenerated. If someone applies DDL by hand in the Supabase dashboard — which is how prod
 * migrations are actually run here — the snapshot silently becomes fiction, and every gate
 * built on it becomes a mirror of itself.
 *
 * So: something must keep the snapshot honest. This does. It is the whole reason the check
 * also runs inside the app against live production.
 *
 * Note it reports drift that does NOT violate the code, too — a constraint tightened by hand
 * in a way today's code happens not to hit is still a loaded gun for tomorrow's code.
 */
export function diffAgainstSnapshot(live: ConstraintDefs, snapshot: ConstraintDefs): SnapshotDrift[] {
  const drift: SnapshotDrift[] = []

  for (const [name, liveDef] of Object.entries(live)) {
    const snapDef = snapshot[name]
    if (snapDef === undefined) {
      drift.push({
        kind: "added",
        constraint: name,
        liveDef,
        message: `"${name}" exists in the live database but NOT in the committed snapshot — the snapshot is stale.`,
      })
    } else if (snapDef !== liveDef) {
      drift.push({
        kind: "changed",
        constraint: name,
        snapshotDef: snapDef,
        liveDef,
        message: `"${name}" has CHANGED in the live database since the snapshot was taken.`,
      })
    }
  }

  for (const name of Object.keys(snapshot)) {
    if (live[name] === undefined) {
      drift.push({
        kind: "removed",
        constraint: name,
        snapshotDef: snapshot[name],
        message: `"${name}" is in the committed snapshot but NOT in the live database — it was dropped.`,
      })
    }
  }

  return drift.sort((a, b) => a.constraint.localeCompare(b.constraint))
}

/**
 * The SQL every transport runs to read the constraint set. One query, so a snapshot taken by
 * the script and a read done by the cron are the same shape by construction.
 */
export const CONSTRAINT_QUERY = `
  SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class t ON t.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND con.contype = 'c'
  ORDER BY con.conname
`.trim()

/** Rows from CONSTRAINT_QUERY → the map every function here takes. */
export function rowsToDefs(rows: Array<{ name: string; def: string }>): ConstraintDefs {
  const defs: ConstraintDefs = {}
  for (const r of rows) defs[r.name] = r.def
  return defs
}
