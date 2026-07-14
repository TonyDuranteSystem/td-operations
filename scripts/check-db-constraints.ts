/* eslint-disable no-console -- CLI gate: reports its findings on stdout. */
/**
 * CODE ↔ DATABASE CONTRACT CHECK.
 *
 * Asserts that every value the code can write into a CHECK-constrained column is a value
 * the database will actually accept.
 *
 * WHY THIS EXISTS — and why it is the only thing on the list that would have caught the
 * 2026-07-14 incident:
 *
 * The code wrote feed statuses (`needs_review`, `activation_crashed`) that production's
 * CHECK constraint did not permit. Every one of those writes was rejected. The code
 * discarded the error. The review queue therefore never worked — for months — while the
 * UI cheerfully rendered an empty "Needs Review" tab and everyone read empty as "nothing
 * to review".
 *
 * Three reviewers and five rounds of adversarial code review missed it, because all of us
 * were reading CODE against CODE. Nobody compared the code against the database it
 * actually writes to. A 32/32 green integration harness proved nothing, because the
 * harness's database (sandbox) had NO constraints at all — strictly more permissive than
 * production. A green run against a more permissive database is not evidence.
 *
 * "Review harder" does not fix that. This does.
 *
 * Usage:
 *   npx tsx scripts/check-db-constraints.ts            # checks the DB in .env.local (sandbox)
 *   npx tsx scripts/check-db-constraints.ts --prod     # checks production (needs .env.prod.local)
 *
 * Exits non-zero on any divergence.
 */

import { config } from "dotenv"
import { Client } from "pg"
import { FEED_STATUSES, MATCH_CONFIDENCES, FEED_SOURCES } from "../lib/finance/feed-vocabulary"

const useProd = process.argv.includes("--prod")
config({ path: useProd ? ".env.prod.local" : ".env.local" })

// A direct connection, the same mechanism `scripts/apply-migration.js` uses. The Supabase
// client cannot read pg_constraint, and the whole point of this check is to ask the
// database what it will actually accept — not to ask the code what it believes.
const DB_URL = process.env.SUPABASE_DB_URL

if (!DB_URL) {
  console.error("Missing SUPABASE_DB_URL — this check reads pg_constraint directly.")
  process.exit(1)
}

/**
 * Every code-side vocabulary that is backed by a database CHECK.
 *
 * Add a row here whenever you add a constrained column — and if you forget, this script
 * FAILS rather than quietly ignoring it (see UNREGISTERED, below). A registry that depends
 * on someone remembering to update it is a note, not a gate, and we have spent a whole day
 * learning what notes are worth.
 */
const CONTRACTS = [
  { table: "td_bank_feeds", column: "status", constraint: "td_bank_feeds_status_check", values: FEED_STATUSES },
  { table: "td_bank_feeds", column: "match_confidence", constraint: "td_bank_feeds_match_confidence_check", values: MATCH_CONFIDENCES },
  { table: "td_bank_feeds", column: "source", constraint: "td_bank_feeds_source_check", values: FEED_SOURCES },
] as const

/**
 * CHECK constraints that are deliberately NOT value-vocabularies — shape rules, not lists.
 * Anything else the database constrains and the code has not registered is reported.
 *
 * This list is the honest boundary of what the check covers. Everything outside it either
 * has a contract above or shows up as UNREGISTERED.
 */
const NOT_A_VOCABULARY = new Set([
  "payments_must_have_payer",
  "invoice_has_owner",
  "payments_bank_preference_check", // regex + enum hybrid
  "client_invoices_recurring_frequency_check",
])

/**
 * KNOWN-UNAUDITED BASELINE — frozen 90 constraints, 2026-07-14.
 *
 * These CHECK-constrained columns exist in the database and NOTHING in the code has ever
 * been verified against them. This is the real size of the blind spot that let the review
 * queue die: 90 places where the code could be writing a value the database
 * rejects, and nobody would know unless a caller happened to check the error.
 *
 * They are frozen here rather than fixed today, deliberately: auditing 90 columns is
 * its own job, and failing the build on all of them would simply get this gate switched off
 * — which is precisely how the last gate died.
 *
 * ⚠️ THIS IS A RATCHET, NOT AN AMNESTY. Any NEW constrained column fails the check until it
 * is registered in CONTRACTS. The list may shrink; it must never grow. When you audit one,
 * delete it from here and add a real contract.
 */
const UNAUDITED_BASELINE = new Set([
  "_bp_new_check",
  "account_bank_balances_source_check",
  "account_location_policies_choice_check",
  "account_location_policies_loc_code_check",
  "accounts_member_structure_check",
  "addresses_kind_check",
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
  "catalog_decision_log_action_check",
  "catalog_decision_log_actor_kind_check",
  "catalog_entries_status_check",
  "catalog_pending_review_source_check",
  "catalog_pending_review_status_check",
  "chart_of_accounts_normal_balance_check",
  "chart_of_accounts_type_check",
  "chk_account_portal_tier",
  "chk_contact_portal_tier",
  "chk_ptm_status",
  "ck_payments_installment_transitional",
  "client_decision_requests_request_type_check",
  "client_decision_requests_status_check",
  "client_threads_source_kind_check",
  "coa_normal_balance_matches_type",
  "comm_conversations_created_by_type_check",
  "comm_conversations_status_check",
  "comm_messages_pinned_by_type_check",
  "comm_messages_sender_type_check",
  "comm_participants_participant_type_check",
  "contact_request_forms_form_type_check",
  "contact_request_forms_status_check",
  "dev_tasks_knowledge_status_check",
  "esign_envelopes_origin_check",
  "esign_envelopes_routing_check",
  "esign_envelopes_status_check",
  "esign_events_type_check",
  "esign_fields_type_check",
  "esign_signers_status_check",
  "esign_template_fields_type_check",
  "esign_templates_status_check",
  "internal_threads_resolution_check",
  "internal_threads_thread_type_chk",
  "internal_threads_work_status_chk",
  "invoice_reminder_log_source_check",
  "journal_entries_status_check",
  "member_info_requests_status_check",
  "members_member_type_check",
  "message_actions_priority_check",
  "messages_content_type_check",
  "messages_direction_check",
  "messages_status_check",
  "messaging_channels_provider_check",
  "messaging_groups_group_type_check",
  "payments_payment_category_check",
  "pnl_period_answers_actor_role_check",
  "pnl_period_answers_choice_check",
  "pnl_workspace_members_member_type_check",
  "pnl_workspaces_status_check",
  "pnl_ws_tx_loc_code_check",
  "pnl_ws_tx_loc_confidence_check",
  "pnl_ws_tx_loc_source_check",
  "portal_announcements_type_check",
  "portal_messages_sender_context_check",
  "portal_messages_sender_type_check",
  "service_catalog_default_service_context_check",
  "statement_format_mappings_status_check",
  "system_errors_source_check",
  "system_errors_status_check",
  "task_action_log_status_check",
  "td_comm_deliverables_type_check",
  "td_comm_disclaimers_method_check",
  "td_comm_enrollments_client_type_check",
  "td_comm_enrollments_status_check",
  "td_comm_packages_payment_timing_check",
  "td_comm_portfolio_consent_source_check",
  "td_comm_questions_audience_check",
  "td_comm_questions_type_check",
  "td_comm_showcase_consents_method_check",
  "worker_prepared_sends_status_check",
  "workflow_dispatch_log_outcome_check",
  "workflow_dispatch_log_trigger_source_check",
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

/** Pull the literals out of a `col = ANY (ARRAY['a'::text, 'b'::text])` definition. */
function parseAllowed(def: string): string[] {
  return Array.from(def.matchAll(/'([^']+)'::text/g)).map(m => m[1])
}

async function main() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()

  const host = DB_URL!.replace(/:[^:@]+@/, ":****@")
  console.log(`Checking code↔DB contract against: ${host}\n`)

  const { rows } = await client.query<{ conname: string; def: string }>(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND c.contype = 'c'`,
  )
  await client.end()

  const byName = new Map(rows.map(r => [r.conname, r.def]))

  let failures = 0

  for (const contract of CONTRACTS) {
    const def = byName.get(contract.constraint)

    if (!def) {
      console.log(`FAIL  ${contract.table}.${contract.column} — constraint "${contract.constraint}" DOES NOT EXIST in this database.`)
      console.log(`      A missing constraint is not "safe": it means this environment accepts values production rejects,`)
      console.log(`      so every test that passes here proves nothing about production. That is exactly what happened.`)
      failures++
      continue
    }

    const allowed = parseAllowed(def)
    const missing = contract.values.filter(v => !allowed.includes(v))
    const extra = allowed.filter(v => !(contract.values as readonly string[]).includes(v))

    if (missing.length === 0 && extra.length === 0) {
      console.log(`PASS  ${contract.table}.${contract.column} — code and database agree (${allowed.length} values).`)
      continue
    }

    if (missing.length > 0) {
      console.log(`FAIL  ${contract.table}.${contract.column} — the code can write values the DATABASE WILL REJECT: ${missing.join(", ")}`)
      console.log(`      These writes will fail silently unless every caller checks the error. Add them to the CHECK via a migration.`)
      failures++
    }
    if (extra.length > 0) {
      console.log(`WARN  ${contract.table}.${contract.column} — the database allows values the code never writes: ${extra.join(", ")}`)
      console.log(`      Harmless, but it usually means a value was retired in code and left behind in the schema.`)
    }
  }

  // ── The registry must maintain itself ────────────────────────────────────────────
  //
  // Every CHECK constraint in the database that looks like a value list, but that no
  // contract above covers, is reported. Without this, "remember to register new columns"
  // is a note — and a note is exactly what failed: `needs_review` was added to the code
  // with three UI surfaces and nobody remembered the database.
  const registered = new Set<string>(CONTRACTS.map(c => c.constraint))
  const unregistered = rows
    .filter(r => !registered.has(r.conname))
    .filter(r => !NOT_A_VOCABULARY.has(r.conname))
    .filter(r => !UNAUDITED_BASELINE.has(r.conname))
    .filter(r => parseAllowed(r.def).length > 0) // value lists only; ignore shape rules

  if (unregistered.length > 0) {
    console.log()
    console.log(`FAIL  ${unregistered.length} NEW CHECK constraint(s) that the code has not registered:`)
    for (const r of unregistered) {
      console.log(`      - ${r.conname}: allows ${parseAllowed(r.def).join(", ")}`)
    }
    console.log(`      Register each one in CONTRACTS (with the code-side list it must match), or add it to`)
    console.log(`      NOT_A_VOCABULARY if it is a shape rule rather than a value list. An unregistered`)
    console.log(`      constrained column is a place where the code can write a value the database rejects —`)
    console.log(`      silently, unless every caller checks the error. That is exactly how the review queue`)
    console.log(`      stayed empty for months.`)
    failures += unregistered.length
  }

  console.log()
  if (failures > 0) {
    console.log(`RESULT: ${failures} contract violation(s). The code and this database do not agree.`)
    process.exit(1)
  }
  console.log("RESULT: code and database agree.")
}

main().catch(err => {
  console.error("Contract check crashed:", err)
  process.exit(1)
})
