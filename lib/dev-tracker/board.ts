/**
 * Dev-tracker board lanes — pure grouping logic shared by the board page and its
 * API. Lanes map 1:1 onto the dev_task_status enum (backlog is shown as
 * "Postponed"; cancelled is hidden). The stored `status` IS the lane — the
 * milestone is the lifecycle detail (see milestones.ts::deriveStatus, which keeps
 * them aligned on the Claude write path; a human drag is an explicit lane override).
 */

export const BOARD_LANES = [
  { key: "todo", label: "To work on", accent: "border-t-zinc-400", badge: "bg-zinc-100 text-zinc-600" },
  { key: "in_progress", label: "In progress", accent: "border-t-blue-500", badge: "bg-blue-100 text-blue-700" },
  { key: "blocked", label: "Blocked / Waiting", accent: "border-t-amber-500", badge: "bg-amber-100 text-amber-700" },
  { key: "backlog", label: "Postponed", accent: "border-t-violet-400", badge: "bg-violet-100 text-violet-700" },
  { key: "done", label: "Done", accent: "border-t-emerald-500", badge: "bg-emerald-100 text-emerald-700" },
] as const

export type BoardLaneKey = (typeof BOARD_LANES)[number]["key"]

/**
 * Lanes shown as active columns on the board grid — everything except "done".
 * Finished work does not belong in the working view; it folds into the
 * collapsed "Recently shipped" drawer (still a drag target so drag-to-complete
 * keeps working). See components/dev-board/dev-board.tsx.
 */
export const ACTIVE_BOARD_LANES = BOARD_LANES.filter((l) => l.key !== "done")

/** The "done" lane meta, rendered as the folded shipped drawer, not a column. */
export const DONE_LANE = BOARD_LANES.find((l) => l.key === "done")!

/** Lane a status belongs to, or null when it should not appear (cancelled). */
export function laneForStatus(status: string): BoardLaneKey | null {
  switch (status) {
    case "todo":
      return "todo"
    case "in_progress":
      return "in_progress"
    case "blocked":
      return "blocked"
    case "backlog":
      return "backlog"
    case "done":
      return "done"
    default:
      return null // cancelled → hidden
  }
}

export const BOARD_LANE_LABEL: Record<BoardLaneKey, string> = BOARD_LANES.reduce(
  (acc, l) => {
    acc[l.key] = l.label
    return acc
  },
  {} as Record<BoardLaneKey, string>,
)

export interface BoardJobLike {
  id: string
  status: string
}

/** Group jobs into ordered lanes. Unknown/cancelled statuses are dropped. */
export function groupJobsByLane<T extends BoardJobLike>(jobs: T[]): Record<BoardLaneKey, T[]> {
  const out: Record<BoardLaneKey, T[]> = {
    todo: [],
    in_progress: [],
    blocked: [],
    backlog: [],
    done: [],
  }
  for (const j of jobs) {
    const lane = laneForStatus(j.status)
    if (lane) out[lane].push(j)
  }
  return out
}

/** Distinct channels present in a job set, sorted, for the filter dropdown. */
export function channelsInJobs<T extends { channel?: string | null }>(jobs: T[]): string[] {
  const set = new Set<string>()
  for (const j of jobs) if (j.channel) set.add(j.channel)
  return Array.from(set).sort()
}
