/**
 * Per-surface control of the worker's full tool reach (dev job 74701b48).
 *
 * "Full reach" means the worker can search the whole ~216-tool catalog and call it via
 * the bridge, instead of being limited to a fixed hand-wired subset. What it may then
 * RUN is decided per call by the risk classifier: tools on the reviewed allow-list run,
 * everything else asks first. Reach is discovery; the classifier is authority.
 *
 * WHY PER-SURFACE. This was one global environment switch shared by Slack, Team Chat and
 * the CRM panels. That meant enabling it anywhere enabled it everywhere, and rolling it
 * back anywhere rolled it back everywhere — including surfaces that were working fine.
 * The council asked for independent switches so the riskiest surface can be turned off
 * on its own, and so a bad turn on one panel is not an all-or-nothing revert.
 *
 * The surfaces are NOT equal risk:
 *   dashboard / inbox / team_chat — staff-facing, no client-authored text in the loop
 *   portal_chat                   — pinned to one client AND ingests text that client
 *                                   wrote, next to a live client-facing send rail
 * portal_chat is therefore the one to switch off first if anything looks wrong.
 *
 * Precedence: the per-surface variable wins; the legacy global is the fallback so
 * existing deployments keep their current behaviour; otherwise the default below.
 * Any value other than "true"/"false" is treated as unset rather than guessed at.
 */

export type ReachSurface = "dashboard" | "inbox" | "portal_chat" | "team_chat" | "slack"

/** Per-surface override, e.g. WORKER_FULL_REACH_PORTAL_CHAT=false. */
const ENV_BY_SURFACE: Record<ReachSurface, string> = {
  dashboard: "WORKER_FULL_REACH_DASHBOARD",
  inbox: "WORKER_FULL_REACH_INBOX",
  portal_chat: "WORKER_FULL_REACH_PORTAL_CHAT",
  team_chat: "WORKER_FULL_REACH_TEAM_CHAT",
  slack: "WORKER_FULL_REACH_SLACK",
}

/**
 * Default when nothing is configured: ON everywhere.
 *
 * Antonio, 2026-07-19: the worker has the same capabilities wherever it is. Holding
 * Slack and Team Chat back was second-guessing a decision he had already made — the
 * reach itself grants nothing beyond lookup, and every dangerous tool now requires
 * approval by name rather than by a guess at its name.
 *
 * The per-surface switches remain, for turning something OFF when it misbehaves in
 * practice. Portal Chats is the one to cut first if anything looks wrong: it is the only
 * surface both pinned to a client and reading text that client wrote, next to a live
 * client-facing send rail.
 */
const DEFAULT_ON: Record<ReachSurface, boolean> = {
  dashboard: true,
  inbox: true,
  portal_chat: true,
  team_chat: true,
  slack: true,
}

function readBool(raw: string | undefined): boolean | null {
  if (raw === undefined) return null
  const v = raw.trim().toLowerCase()
  if (v === "true") return true
  if (v === "false") return false
  return null // unrecognised → treat as unset, never guess
}

/** Whether this surface may search and call the full catalog on this turn. */
export function fullReachEnabledFor(surface: ReachSurface): boolean {
  const perSurface = readBool(process.env[ENV_BY_SURFACE[surface]])
  if (perSurface !== null) return perSurface
  const legacyGlobal = readBool(process.env.ASSISTANT_FULL_REACH_ENABLED)
  if (legacyGlobal !== null) return legacyGlobal
  return DEFAULT_ON[surface]
}
