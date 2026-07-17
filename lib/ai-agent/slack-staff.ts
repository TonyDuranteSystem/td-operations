/**
 * Slack staff allow-list for privileged, no-approval actions (the 🧠 memory
 * save). Distinct from `isAuthorizedApprover` (Antonio-only, for the action
 * approval rail) — 🧠 is a routine save any STAFF member may do, but NOT a
 * channel guest or a client in a shared channel.
 *
 * Bug (2026-07-17 council): the 🧠 reaction handler only excluded the Claude
 * bot, so ANY Slack member could write global decision-memory, and every save
 * was hardcoded-attributed to "Antonio". This module is the staff gate + the
 * real-actor resolver.
 *
 * Ids come from the worker's existing constants (Antonio, Luca) and can be
 * extended without a deploy via env `SLACK_STAFF_USER_IDS` (comma-separated).
 * Pure + dependency-free so it's unit-testable.
 */

const CLAUDE_BOT_USER_ID = "U0B9S675WTT"

// Known staff Slack user ids → display name. Mirrors KNOWN_SLACK_USERS
// (lib/team/slack-mirror-classify.ts) minus the Claude bot.
const STAFF_NAMES: Record<string, string> = {
  U0BAALR4Y4Q: "Antonio",
  U0B9ZUE2Q75: "Luca",
}

/** Extra staff ids from env (comma-separated), added at read time (no deploy). */
function envStaffIds(): string[] {
  return (process.env.SLACK_STAFF_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** True only for a known staff member (never the Claude bot, never a guest/client). */
export function isSlackStaff(userId: string | null | undefined): boolean {
  if (!userId || userId === CLAUDE_BOT_USER_ID) return false
  return userId in STAFF_NAMES || envStaffIds().includes(userId)
}

/**
 * Display name for a staff member, for attribution on a saved memory. Returns
 * the mapped name, or "TD Team" for an env-configured staff id we don't have a
 * name for — never a hardcoded "Antonio".
 */
export function slackStaffName(userId: string | null | undefined): string | null {
  if (!isSlackStaff(userId)) return null
  return STAFF_NAMES[userId as string] ?? "TD Team"
}
