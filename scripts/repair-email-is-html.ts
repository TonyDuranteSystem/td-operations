/* eslint-disable no-console -- CLI script: console IS the output. */
/**
 * ONE-TIME `is_html` repair pass (dev_task 1c453653-e93a-4875-bcd6-6033070d062b)
 * — Antonio asked for every already-captured email to render with proper
 * paragraphs, not just new mail. This fills in the real MIME-derived flag for
 * every message captured before that column existed.
 *
 * Cheaper than the original backfill: ONE Gmail get per message, no attachment
 * downloads, no storage writes — only the is_html column changes. Still runs
 * through the same bounded-concurrency + inter-batch pause as every other
 * Gmail-quota-sensitive job here, so a full historical sweep (tens of
 * thousands of messages) can't repeat the 2026-08-02 quota incident.
 *
 * Resumable: each batch only pulls rows still missing is_html, so a crash or
 * Ctrl-C just re-runs and picks up where it left off; already-repaired rows
 * are never re-touched.
 *
 * RUNS AGAINST LIVE GMAIL — needs production creds. Run OFF-HOURS.
 *
 * Usage (deliberate — guarded so it can't fire by accident):
 *   CONFIRM_IS_HTML_REPAIR=1 npx tsx scripts/repair-email-is-html.ts
 *   CONFIRM_IS_HTML_REPAIR=1 MAILBOX=support npx tsx scripts/repair-email-is-html.ts
 *   CONFIRM_IS_HTML_REPAIR=1 CONCURRENCY=6 BATCH_LIMIT=200 npx tsx scripts/repair-email-is-html.ts
 */
import { buildRepairIO, repairAllIsHtml } from "@/lib/email-store/repair-is-html"
import type { Mailbox } from "@/lib/email-store/paths"

async function main() {
  if (process.env.CONFIRM_IS_HTML_REPAIR !== "1") {
    console.error(
      "Refused: set CONFIRM_IS_HTML_REPAIR=1 to run the one-time is_html repair.\n" +
      "This re-asks LIVE Gmail for the MIME type of every already-captured email.",
    )
    process.exit(2)
  }

  const requestedMailbox = process.env.MAILBOX as Mailbox | undefined
  const mailboxes: Mailbox[] =
    requestedMailbox === "support" || requestedMailbox === "antonio"
      ? [requestedMailbox]
      : ["support", "antonio"]

  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY || "6", 10))
  const limit = Math.max(1, parseInt(process.env.BATCH_LIMIT || "200", 10))
  const sleepMs = Math.max(0, parseInt(process.env.BATCH_SLEEP_MS || "1000", 10))

  const io = buildRepairIO()
  const startedAt = Date.now()
  console.log(`[is-html-repair] starting — mailboxes ${mailboxes.join(", ")}, concurrency ${concurrency}, batch ${limit}`)

  let totalUpdated = 0
  let totalErrors = 0
  for (const mailbox of mailboxes) {
    const totals = await repairAllIsHtml(mailbox, io, {
      concurrency, limit, sleepMs,
      onBatch: (b) => console.log(`[is-html-repair] ${mailbox}: batch fetched ${b.fetched}, updated ${b.updated}, errors ${b.errors}`),
    })
    console.log(`[is-html-repair] ${mailbox}: DONE — ${totals.batches} batches, ${totals.updated} updated, ${totals.errors} errors`)
    totalUpdated += totals.updated
    totalErrors += totals.errors
  }

  console.log(`[is-html-repair] all done in ${Math.round((Date.now() - startedAt) / 1000)}s — ${totalUpdated} updated, ${totalErrors} errors`)
  if (totalErrors > 0) {
    console.log("[is-html-repair] re-run to retry errors (already-repaired rows are skipped automatically).")
  }
}

main().catch((err) => {
  console.error("[is-html-repair] FATAL:", err)
  process.exit(1)
})
