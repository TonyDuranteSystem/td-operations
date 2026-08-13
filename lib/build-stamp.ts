/**
 * The build stamp shown in the sandbox banner.
 *
 * WHY (Antonio, 2026-08-12): he spent an hour QA-ing a pinned deployment URL
 * that was six hours behind the code, with nothing on screen to reveal it.
 * "I must be able to see, in one glance, which build I'm testing."
 *
 * The values are injected at BUILD time by scripts/deploy-sandbox.sh from the
 * local git checkout. They cannot come from Vercel's own git variables: this
 * project is deliberately git-DISCONNECTED (2026-08-07, to stop main builds
 * stealing the sandbox alias), so VERCEL_GIT_COMMIT_SHA is empty here.
 */

/**
 * An unstamped build must ANNOUNCE itself rather than render an empty gap that
 * reads like a clean stamp — a silent blank is exactly the failure this whole
 * feature exists to prevent.
 */
export function buildStampLabel(sha: string, time: string): string {
  const parts = [sha.trim(), time.trim()].filter(Boolean)
  return parts.length ? parts.join(" · ") : "build unknown"
}
