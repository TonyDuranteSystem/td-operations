/**
 * Hermes ↔ Claude bridge — Phase D: approval-rail environment lane.
 *
 * dev_task: 1a0d1354 (Hermes operating agent) — Phase D (staging-lane foundation)
 *
 * The `approval_queue.env` column tags which lane a proposal belongs to so a
 * future staging executor can run staging proposals without touching production.
 * This is the single source of truth for "which lane am I?":
 *
 *   currentApprovalEnv() = APPROVAL_ENV  (explicit override, the staging knob)
 *                        ?? NODE_ENV     (vercel prod + sandbox both = 'production')
 *                        ?? 'production' (final fallback = the column default)
 *
 * INVARIANT that keeps this safe: the PROPOSER (proposeAction) and the EXECUTOR
 * (approval-executor) run in the SAME process environment, so they resolve the
 * SAME value and always agree. By default this is 'production' on every real
 * deployment — matching the column default and every existing row — so the env
 * filter is INERT until someone deliberately sets APPROVAL_ENV. Setting
 * APPROVAL_ENV='staging' on a deployment carves out an isolated lane: its
 * proposals get env='staging' and only its executor (also 'staging') runs them.
 */

/** The approval lane this process proposes into / executes for. Never empty. */
export function currentApprovalEnv(): string {
  const explicit = process.env.APPROVAL_ENV?.trim()
  if (explicit) return explicit
  const nodeEnv = process.env.NODE_ENV?.trim()
  if (nodeEnv) return nodeEnv
  return "production"
}
