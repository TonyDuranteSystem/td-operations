/**
 * One-time backfill: AI-write the plain-English card fields (summary_plain,
 * business_impact, simple_next_step) for existing dev_tasks that predate the
 * summarizer (dev_task 23dd6246). Uses the SAME choke-point as the live write
 * paths (lib/dev-tracker/plain-summary.ts), so backfilled cards read exactly
 * like new ones.
 *
 * Scope: non-cancelled jobs with no AI generation yet (plain_generated_at IS
 * NULL). Existing summary_plain is fed to the AI as a hint, same as live.
 *
 * Usage:
 *   npx tsx scripts/backfill-dev-plain-fields.ts --dry-run     # list, no writes
 *   npx tsx scripts/backfill-dev-plain-fields.ts --limit=5     # small trial
 *   npx tsx scripts/backfill-dev-plain-fields.ts               # full run
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + ANTHROPIC_API_KEY
 * from .env.local (dotenv) — same convention as scripts/apply-migration.js, so
 * it targets SANDBOX unless .env.local says otherwise. Run against production
 * only on Antonio's explicit word (with the prod env in the shell).
 */

import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"
import { generatePlainFields, progressTail } from "@/lib/dev-tracker/plain-summary"
import { labelForStage, parseMilestones } from "@/lib/dev-tracker/milestones"
import { loadStageSetForType } from "@/lib/dev-tracker/load-stage-set"

config({ path: ".env.local" })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local")
  process.exit(1)
}

const DRY_RUN = process.argv.includes("--dry-run")

// Dry runs never call the AI, so the key is only required for a real run.
if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY — the summarizer needs it (dry runs don't)")
  process.exit(1)
}
const limitArg = process.argv.find((a) => a.startsWith("--limit="))
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split("=")[1], 10) || 1) : 500

// PRODUCTION GUARD (council 2026-07-16): dotenv does NOT override shell env, so
// a shell that exported prod vars would silently point this script at prod and
// rewrite every card's summary there. Prod runs must be explicit + dry-run-able.
const PROD_REF = "ydzipybqeebtpcvsbtvs"
if (SUPABASE_URL.includes(PROD_REF) && !process.argv.includes("--allow-prod")) {
  console.error(
    `REFUSING: target is PRODUCTION (${SUPABASE_URL}).\n` +
      "This overwrites summary_plain on every un-backfilled card. Run with --allow-prod\n" +
      "only on Antonio's explicit word (start with --allow-prod --dry-run).",
  )
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_KEY)

async function main() {
  console.warn(`Backfill target: ${SUPABASE_URL} ${DRY_RUN ? "(DRY RUN)" : ""}`)

  const { data: rows, error } = await db
    .from("dev_tasks")
    .select("id, title, type, priority, status, channel, milestones, description, findings, plan, decisions, blockers, summary_plain, progress_log, plain_generated_at")
    .neq("status", "cancelled")
    .is("plain_generated_at", null)
    .order("updated_at", { ascending: false })
    .limit(LIMIT)

  if (error) {
    console.error("Query failed:", error.message)
    process.exit(1)
  }
  console.warn(`${rows?.length ?? 0} card(s) need plain fields.`)
  if (!rows?.length) return

  let ok = 0
  let failed = 0

  for (const row of rows) {
    const label = `${row.id.slice(0, 8)} · ${String(row.title).slice(0, 60)}`
    if (DRY_RUN) {
      console.warn(`would backfill: ${label}`)
      continue
    }
    const set = await loadStageSetForType(db, row.type)
    const ms = parseMilestones(row.milestones)
    const ai = await generatePlainFields({
      title: row.title,
      type: row.type,
      priority: row.priority,
      channel: row.channel,
      stageLabel: ms ? labelForStage(set, ms.current) : null,
      description: row.description,
      findings: row.findings,
      plan: row.plan,
      decisions: row.decisions,
      blockers: row.blockers,
      callerSummary: row.summary_plain,
      progressTail: progressTail(row.progress_log),
    })
    if (!ai) {
      failed++
      console.error(`FAILED (AI): ${label}`)
      continue
    }
    const { error: patchErr } = await db
      .from("dev_tasks")
      .update({
        summary_plain: ai.summary_plain,
        business_impact: ai.business_impact,
        simple_next_step: ai.simple_next_step,
        plain_generated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
    if (patchErr) {
      failed++
      console.error(`FAILED (DB): ${label} — ${patchErr.message}`)
      continue
    }
    ok++
    console.warn(`backfilled: ${label}`)
  }

  console.warn(`\nDone. ${ok} backfilled, ${failed} failed${failed ? " (re-run to retry — plain_generated_at stays NULL on failure)" : ""}.`)
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error("Backfill crashed:", e instanceof Error ? e.message : String(e))
  process.exit(1)
})
