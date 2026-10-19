/* eslint-disable no-console -- a SANDBOX QA script */
/**
 * QA t40 — Stop Drive S1c round 5 (dev job 264bb882). SANDBOX only, read-only. Every archive recipe's sweep window runs against the
 * REAL PostgREST filters (company join, finished filter, real-rows filter) without a database error.
 *   QA_ENV_FILE=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t40-stop-drive-round5-recipes.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.QA_ENV_FILE ?? ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { ARCHIVE_RECIPES } = await import("../../../lib/forms/archive-registry")
  const { readSweepWindow } = await import("../../../lib/archive/skip-no-drive-folder")
  for (const recipe of Object.values(ARCHIVE_RECIPES)) {
    const w = await readSweepWindow<Record<string, unknown>>(recipe.table, recipe.selectColumns, {
      cutoffIso: recipe.sweepNotBefore ?? "2026-07-24T00:00:00Z",
      realFilter: recipe.sweepRealFilter ?? "status.in.(completed,reviewed)",
      hasAccount: recipe.sweepHasAccount,
    })
    check(`${recipe.formType}: the sweep window query runs against the real database`, !w.readError, JSON.stringify({ err: w.readError, rows: w.candidates.length, skippedFinished: w.skippedFinished }))
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
