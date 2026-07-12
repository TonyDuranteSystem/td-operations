import { describe, it, expect } from "vitest"
import {
  BOARD_LANES,
  ACTIVE_BOARD_LANES,
  DONE_LANE,
  laneForStatus,
  groupJobsByLane,
  channelsInJobs,
  BOARD_LANE_LABEL,
} from "@/lib/dev-tracker/board"

describe("board lanes", () => {
  it("has five ordered lanes ending in Done", () => {
    expect(BOARD_LANES.map((l) => l.key)).toEqual([
      "todo",
      "in_progress",
      "blocked",
      "backlog",
      "done",
    ])
    expect(BOARD_LANE_LABEL.backlog).toBe("Postponed")
  })

  it("active lanes are the four working columns; done folds out separately", () => {
    expect(ACTIVE_BOARD_LANES.map((l) => l.key)).toEqual([
      "todo",
      "in_progress",
      "blocked",
      "backlog",
    ])
    expect(ACTIVE_BOARD_LANES.some((l) => l.key === "done")).toBe(false)
    expect(DONE_LANE.key).toBe("done")
  })

  it("maps statuses to lanes; cancelled is hidden", () => {
    expect(laneForStatus("todo")).toBe("todo")
    expect(laneForStatus("in_progress")).toBe("in_progress")
    expect(laneForStatus("blocked")).toBe("blocked")
    expect(laneForStatus("backlog")).toBe("backlog")
    expect(laneForStatus("done")).toBe("done")
    expect(laneForStatus("cancelled")).toBeNull()
    expect(laneForStatus("weird")).toBeNull()
  })
})

describe("groupJobsByLane", () => {
  it("buckets jobs and drops cancelled/unknown", () => {
    const jobs = [
      { id: "a", status: "todo" },
      { id: "b", status: "in_progress" },
      { id: "c", status: "backlog" },
      { id: "d", status: "done" },
      { id: "e", status: "cancelled" },
      { id: "f", status: "todo" },
    ]
    const g = groupJobsByLane(jobs)
    expect(g.todo.map((j) => j.id)).toEqual(["a", "f"])
    expect(g.in_progress.map((j) => j.id)).toEqual(["b"])
    expect(g.backlog.map((j) => j.id)).toEqual(["c"])
    expect(g.done.map((j) => j.id)).toEqual(["d"])
    expect(g.blocked).toEqual([])
    // cancelled 'e' dropped entirely
    const all = Object.values(g).flat()
    expect(all.find((j) => j.id === "e")).toBeUndefined()
  })
})

describe("channelsInJobs", () => {
  it("returns sorted distinct channels, ignoring null", () => {
    expect(
      channelsInJobs([
        { channel: "td-dev" },
        { channel: "td-bug" },
        { channel: null },
        { channel: "td-dev" },
        { channel: undefined },
      ]),
    ).toEqual(["td-bug", "td-dev"])
  })
})
