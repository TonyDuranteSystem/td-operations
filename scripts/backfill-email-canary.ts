/* eslint-disable no-console -- CLI script: console IS the output. */
/**
 * SAFE FIRST-RUN canary for the Own-Inbox backfill (dev_task 01800da8).
 *
 * Pulls a SMALL recent slice of ONE mailbox (default: last 7 days of support@)
 * so you can watch the capture work on real Gmail — a few hundred emails, seconds
 * — BEFORE running the full ~10-minute backfill. Uses the reconciler, so it's
 * also self-verifying: it lists what Gmail has in the window, stores whatever's
 * missing, and reports the tally. Re-runnable (insert-once).
 *
 * RUNS AGAINST LIVE GMAIL (production creds). Not exercisable in sandbox.
 *
 * Usage:
 *   CONFIRM_EMAIL_CANARY=1 npx tsx scripts/backfill-email-canary.ts
 *   CONFIRM_EMAIL_CANARY=1 MAILBOX=antonio DAYS=3 npx tsx scripts/backfill-email-canary.ts
 */
import { reconcileWindow, recentWindowSec } from "@/lib/email-store/reconcile"
import type { Mailbox } from "@/lib/email-store/paths"

async function main() {
  if (process.env.CONFIRM_EMAIL_CANARY !== "1") {
    console.error("Refused: set CONFIRM_EMAIL_CANARY=1 to run the small first-slice canary.")
    process.exit(2)
  }
  const mailbox = (process.env.MAILBOX === "antonio" ? "antonio" : "support") as Mailbox
  const days = Math.max(1, parseInt(process.env.DAYS || "7", 10))
  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY || "5", 10))

  const nowSec = Math.floor(Date.now() / 1000)
  const { afterSec, beforeSec } = recentWindowSec(nowSec, days)
  console.log(`[email-canary] ${mailbox}: reconciling last ${days} day(s), concurrency ${concurrency}`)

  const startedAt = Date.now()
  const t = await reconcileWindow({ mailbox, afterSec, beforeSec, concurrency })

  console.log(
    `[email-canary] ${t.mailbox}: Gmail has ${t.inGmail}, already stored ${t.alreadyStored}, ` +
    `missing ${t.missing}, repaired ${t.repaired}, error ${t.error} ` +
    `(${Math.round((Date.now() - startedAt) / 1000)}s)`,
  )
  if (t.error > 0) {
    console.log("[email-canary] some captures errored — re-run to retry (insert-once skips done). Investigate before the full backfill.")
    process.exit(1)
  }
  console.log("[email-canary] clean — safe to run the full backfill next.")
}

main().catch((err) => {
  console.error("[email-canary] FATAL:", err)
  process.exit(1)
})
