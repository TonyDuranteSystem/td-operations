/**
 * Pure helpers for Code Tasks runner health + stuck-job detection. Side-effect-free
 * so they're unit-tested without a DB. Used by GET /api/code-tasks to surface a
 * "Mac Mini online / last seen" badge and flag tasks that look stuck.
 *
 * Heartbeat: the Mac Mini runner upserts hermes_instances(instance_id='code-runner-mac-mini')
 * every tick (~15s). "Online" = a heartbeat within RUNNER_ONLINE_WINDOW_SEC.
 */

// A heartbeat lands every ~15s; allow ~4 missed beats before calling it offline.
export const RUNNER_ONLINE_WINDOW_SEC = 60
// The runner claims a pending task within ~15s; still pending after 3 min ⇒ likely
// stuck (runner down, or not claiming).
export const PENDING_STUCK_SEC = 180
// The runner self-kills a task at 30 min; still processing past 35 min ⇒ stuck.
export const PROCESSING_STUCK_SEC = 35 * 60

export interface RunnerHealth {
  online: boolean
  seconds_ago: number | null
  last_heartbeat: string | null
}

export function runnerHealth(lastHeartbeatIso: string | null | undefined, nowMs: number): RunnerHealth {
  if (!lastHeartbeatIso) return { online: false, seconds_ago: null, last_heartbeat: null }
  const ts = Date.parse(lastHeartbeatIso)
  if (Number.isNaN(ts)) return { online: false, seconds_ago: null, last_heartbeat: lastHeartbeatIso }
  const secondsAgo = Math.max(0, Math.round((nowMs - ts) / 1000))
  return { online: secondsAgo <= RUNNER_ONLINE_WINDOW_SEC, seconds_ago: secondsAgo, last_heartbeat: lastHeartbeatIso }
}

export interface StuckCheckTask {
  status: string
  created_at?: string | null
  updated_at?: string | null
}

export function isTaskStuck(task: StuckCheckTask, nowMs: number): boolean {
  const ageSec = (iso: string | null | undefined): number => {
    if (!iso) return 0
    const ts = Date.parse(iso)
    return Number.isNaN(ts) ? 0 : Math.max(0, (nowMs - ts) / 1000)
  }
  if (task.status === "pending") return ageSec(task.created_at) > PENDING_STUCK_SEC
  if (task.status === "processing") return ageSec(task.updated_at) > PROCESSING_STUCK_SEC
  return false
}
