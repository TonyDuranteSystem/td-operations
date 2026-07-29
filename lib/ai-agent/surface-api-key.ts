/**
 * Which Anthropic key a worker SURFACE runs on — configuration, not a hardcode.
 *
 * THE OUTAGE THIS REPLACES (2026-07-29, Luca's report "Claude in td-taxreturn
 * doesn't work"). Team Chat's @claude passed `process.env.SLACK_WORKER_ANTHROPIC_KEY`
 * as its key override — a surface we use every day, hardwired in code to a key
 * NAMED AFTER a surface being retired. When the Slack key was disabled at Anthropic,
 * Team Chat went down with it: the override was still present (so the fallback never
 * engaged) and every call was rejected. Nothing in the name warned that killing the
 * "Slack" key would kill Team Chat.
 *
 * NOW: a surface's key comes from env by CONVENTION — `WORKER_KEY_<SURFACE>`
 * (uppercased, non-alphanumerics → `_`, e.g. `WORKER_KEY_TEAM_CHAT`,
 * `WORKER_KEY_SLACK`). Unset (or set-but-empty) means "use the shared
 * ANTHROPIC_API_KEY", which resolveWorkerApiKey already implements. Retiring a
 * surface's key is deleting one env var; giving a surface its own budget is adding
 * one. No code changes, no other surface affected.
 *
 * LEGACY: `SLACK_WORKER_ANTHROPIC_KEY` is honoured for the `slack` surface only,
 * so existing deployments keep working until the var is deleted. It is NOT
 * honoured for team_chat — that coupling is the bug.
 */

/** Env-var name for a surface's dedicated key, e.g. "team_chat" → "WORKER_KEY_TEAM_CHAT". */
export function surfaceKeyEnvName(surface: string): string {
  return `WORKER_KEY_${surface.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
}

/**
 * The key override for a surface, or undefined to use the shared key.
 *
 * Reads process.env at CALL time (not module load) so a Vercel env change takes
 * effect on the next invocation without a code path being redeployed.
 */
export function surfaceApiKeyOverride(surface: string): string | undefined {
  const dedicated = process.env[surfaceKeyEnvName(surface)]
  if (dedicated && dedicated.trim().length > 0) return dedicated.trim()
  // Legacy name, slack only — see header. Deliberately NOT a general fallback:
  // handing the legacy slack key to every surface is the exact blast-radius
  // coupling this module removes.
  if (surface === "slack") {
    const legacy = process.env.SLACK_WORKER_ANTHROPIC_KEY
    if (legacy && legacy.trim().length > 0) return legacy.trim()
  }
  return undefined
}
