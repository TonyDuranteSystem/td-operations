/* eslint-disable no-console -- CLI script: console IS the output. */
/**
 * ONE-TIME historical email-content backfill (dev_task 01800da8).
 *
 * Downloads every email's body + attachments from Gmail into our own store,
 * fast: enumerate ids → drain with bounded concurrency → both mailboxes in
 * parallel. ~10 min end-to-end (council 2026-08-01). Resumable (insert-once):
 * safe to re-run; it only picks up what's still missing.
 *
 * RUNS AGAINST LIVE GMAIL — needs production creds (GOOGLE_SA_KEY, Supabase
 * service key). Not exercisable in sandbox (no Gmail). Run OFF-HOURS so it does
 * not share the live inbox's per-user quota during the workday.
 *
 * Usage (deliberate — guarded so it can't fire by accident):
 *   CONFIRM_EMAIL_BACKFILL=1 npx tsx scripts/backfill-email-content.ts
 *   CONFIRM_EMAIL_BACKFILL=1 CONCURRENCY=10 npx tsx scripts/backfill-email-content.ts
 */
import { runFullBackfillAllMailboxes } from "@/lib/email-store/runner"

async function main() {
  if (process.env.CONFIRM_EMAIL_BACKFILL !== "1") {
    console.error(
      "Refused: set CONFIRM_EMAIL_BACKFILL=1 to run the one-time email-content backfill.\n" +
      "This pulls every email body + attachment from LIVE Gmail into our store.",
    )
    process.exit(2)
  }
  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY || "10", 10))
  const startedAt = Date.now()
  console.log(`[email-backfill] starting — concurrency ${concurrency}/mailbox, both mailboxes in parallel`)

  const tallies = await runFullBackfillAllMailboxes(concurrency)

  for (const t of tallies) {
    console.log(
      `[email-backfill] ${t.mailbox}: enumerated ${t.enumerated}, ` +
      `complete ${t.complete}, skipped ${t.skipped}, error ${t.error}`,
    )
  }
  const totalError = tallies.reduce((n, t) => n + t.error, 0)
  console.log(`[email-backfill] done in ${Math.round((Date.now() - startedAt) / 1000)}s — ${totalError} error(s)`)
  if (totalError > 0) {
    console.log("[email-backfill] re-run to retry errored messages (insert-once skips completed).")
  }
}

main().catch((err) => {
  console.error("[email-backfill] FATAL:", err)
  process.exit(1)
})
