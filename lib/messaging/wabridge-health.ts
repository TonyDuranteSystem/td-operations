/**
 * Health of the self-hosted WhatsApp bridge (GOWA on the Mac Mini).
 *
 * GOWA emits NO connect/disconnect webhook, so a dropped link would be silent. A small script on the Mac
 * (launchd com.td.wa-bridge-heartbeat, every 60 s) reports a SIGNED `{event:"bridge.heartbeat", ts, ...}`
 * to the channel's receiver, which records it in wa_bridge_state through an atomic RPC. A cron
 * (/api/cron/wa-bridge-watch) then calls decideBridgeAlert() and emails staff ONCE per problem.
 *
 * Pure — no I/O — so every state transition is unit-testable.
 */

export const HEARTBEAT_STALE_MS = 6 * 60_000 // 5-minute cron + 1 missed 60s beat of slack
/** A heartbeat body is only accepted if its signed timestamp is this fresh (blocks replaying a captured beat). */
export const HEARTBEAT_MAX_SKEW_MS = 2 * 60_000
/** connected=false while still logged in is usually a routine reconnect; only alert once it has lasted this many beats (~minutes). */
export const DISCONNECT_AFTER_BEATS = 5

export interface BridgeState {
  last_heartbeat_at?: string | null
  /** GOWA process answered on localhost. false ⇒ the program itself is down (Mac up, bridge dead). */
  reachable?: boolean | null
  connected?: boolean | null
  logged_in?: boolean | null
  /** Consecutive unhealthy heartbeats (reset by a healthy one). */
  bad_beats?: number | null
  /** The problem we last emailed about; cleared on recovery so a NEW outage alerts again. */
  alerted_state?: BridgeProblem | string | null
}

export type BridgeProblem = "offline" | "process_down" | "unlinked" | "disconnected"
export type BridgeHealth = "ok" | BridgeProblem

export interface AlertDecision {
  health: BridgeHealth
  /** Send an email now (a new problem, not one already alerted). */
  alert: boolean
  /** New value for alerted_state, or undefined to leave it alone. */
  nextAlertedState: BridgeProblem | null | undefined
  /** Human wording for the email. */
  reason: string
  hint: string
}

/** Classify the bridge from its last report. No heartbeat ever = not monitored yet. */
export function classifyBridge(bridge: BridgeState | null | undefined, now: Date): BridgeHealth | "unmonitored" {
  if (!bridge?.last_heartbeat_at) return "unmonitored"
  const last = Date.parse(bridge.last_heartbeat_at)
  if (Number.isNaN(last) || now.getTime() - last > HEARTBEAT_STALE_MS) return "offline"
  if (bridge.reachable === false) return "process_down"
  // logged_in=false is definitive (logged out / phone unused 14 days / device removed) — alert at once.
  if (bridge.logged_in === false) return "unlinked"
  // connected=false while still logged in is normally a transient reconnect — only a sustained one is a problem.
  if (bridge.connected === false && (bridge.bad_beats ?? 0) >= DISCONNECT_AFTER_BEATS) return "disconnected"
  return "ok"
}

const TEXT: Record<BridgeProblem, { reason: string; hint: string }> = {
  offline: {
    reason: "The WhatsApp bridge has stopped reporting (no heartbeat for several minutes).",
    hint: "The Mac Mini may be off, asleep or offline. Check it is on and connected to the internet — the bridge restarts by itself once it is back. Messages sent to the number meanwhile are held by WhatsApp and normally arrive after reconnect, but do not wait long.",
  },
  process_down: {
    reason: "The Mac Mini is up but the WhatsApp bridge program is not running.",
    hint: "It is set to restart automatically. If this alert repeats, open Terminal on the Mac Mini and run: launchctl kickstart -k gui/$(id -u)/com.td.wa-bridge",
  },
  unlinked: {
    reason: "WhatsApp unlinked this device (logged out from the phone, or the phone was not used for 14 days).",
    hint: "Messages are NOT being received. Re-link the number: WhatsApp on the phone → Settings → Linked devices → Link a device, using a fresh code from the bridge.",
  },
  disconnected: {
    reason: "The bridge has been unable to reach WhatsApp for several minutes (still linked, but not connected).",
    hint: "Usually the Mac Mini's internet connection or a WhatsApp outage. Check the Mac Mini's network; if it persists, restart the bridge: launchctl kickstart -k gui/$(id -u)/com.td.wa-bridge",
  },
}

export function decideBridgeAlert(bridge: BridgeState | null | undefined, now: Date): AlertDecision | null {
  const health = classifyBridge(bridge, now)
  if (health === "unmonitored") return null
  const alerted = (bridge?.alerted_state ?? null) as string | null

  if (health === "ok") {
    // Recovery: clear the marker so the NEXT outage emails again. No email for a recovery.
    return { health, alert: false, nextAlertedState: alerted ? null : undefined, reason: "", hint: "" }
  }
  const text = TEXT[health]
  if (alerted === health) {
    return { health, alert: false, nextAlertedState: undefined, ...text } // already told them about this one
  }
  return { health, alert: true, nextAlertedState: health, ...text }
}

export type HeartbeatParse =
  | null // not a heartbeat at all
  | { ok: false; reason: string }
  | { ok: true; reachable: boolean; connected: boolean; logged_in: boolean }

/**
 * Validate an untrusted heartbeat body. Unlike the first version, every field is REQUIRED and the signed
 * timestamp must be fresh: a captured signed heartbeat can no longer be replayed to hide an outage, and a
 * buggy script that omits fields can no longer read as "healthy".
 */
export function parseHeartbeat(body: unknown, now: Date): HeartbeatParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.heartbeat") return null
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing timestamp" }
  }
  if (typeof b.reachable !== "boolean" || typeof b.connected !== "boolean" || typeof b.logged_in !== "boolean") {
    return { ok: false, reason: "reachable/connected/logged_in must all be booleans" }
  }
  return { ok: true, reachable: b.reachable, connected: b.connected, logged_in: b.logged_in }
}
