import { describe, it, expect } from "vitest"
import {
  MILESTONE_STAGES,
  isMilestoneStage,
  stageOrder,
  initialMilestones,
  advanceMilestone,
  deriveStatus,
  parseMilestones,
  STAGE_FIELD,
  notesForStage,
  DEFAULT_STAGE_SET,
  deriveStatusForSet,
  stageDef,
  isKeyInSet,
  labelForStage,
  type StageSet,
} from "@/lib/dev-tracker/milestones"

const NOW = "2026-07-11T10:00:00.000Z"
const LATER = "2026-07-11T11:00:00.000Z"

describe("milestone stages", () => {
  it("has the expected 7-step ladder in order", () => {
    expect(MILESTONE_STAGES).toEqual([
      "requested",
      "investigated",
      "plan_approved",
      "building",
      "qa_passed",
      "shipped",
      "verified",
    ])
  })

  it("isMilestoneStage guards unknown values", () => {
    expect(isMilestoneStage("building")).toBe(true)
    expect(isMilestoneStage("nope")).toBe(false)
    expect(isMilestoneStage(null)).toBe(false)
    expect(isMilestoneStage(3)).toBe(false)
  })

  it("stageOrder returns ladder index", () => {
    expect(stageOrder("requested")).toBe(0)
    expect(stageOrder("verified")).toBe(6)
  })
})

describe("initialMilestones", () => {
  it("seeds at requested with one history entry", () => {
    const m = initialMilestones(NOW, "Claude")
    expect(m.current).toBe("requested")
    expect(m.history).toEqual([{ stage: "requested", at: NOW, by: "Claude" }])
  })
})

describe("advanceMilestone", () => {
  it("moves forward and appends history without mutating input", () => {
    const start = initialMilestones(NOW)
    const next = advanceMilestone(start, "investigated", LATER, "Claude", "audit done")
    expect(next.current).toBe("investigated")
    expect(next.history).toHaveLength(2)
    expect(next.history[1]).toEqual({ stage: "investigated", at: LATER, by: "Claude", note: "audit done" })
    // input untouched
    expect(start.current).toBe("requested")
    expect(start.history).toHaveLength(1)
  })

  it("moves BACKWARD (QA fail -> building) and keeps the trail", () => {
    let m = initialMilestones(NOW)
    m = advanceMilestone(m, "qa_passed", NOW)
    m = advanceMilestone(m, "building", LATER, "Claude", "QA failed, back to fix")
    expect(m.current).toBe("building")
    expect(m.history.map((h) => h.stage)).toEqual(["requested", "qa_passed", "building"])
  })

  it("tolerates null/undefined previous", () => {
    const m = advanceMilestone(null, "building", NOW)
    expect(m.current).toBe("building")
    expect(m.history).toEqual([{ stage: "building", at: NOW, by: undefined, note: undefined }])
  })
})

describe("deriveStatus — the single lane rule", () => {
  it("maps stages to lanes", () => {
    expect(deriveStatus("requested")).toBe("todo")
    expect(deriveStatus("investigated")).toBe("in_progress")
    expect(deriveStatus("plan_approved")).toBe("in_progress")
    expect(deriveStatus("building")).toBe("in_progress")
    expect(deriveStatus("qa_passed")).toBe("in_progress")
    expect(deriveStatus("shipped")).toBe("in_progress")
    expect(deriveStatus("verified")).toBe("done")
  })

  it("overrides win over the stage", () => {
    expect(deriveStatus("building", { blocked: true })).toBe("blocked")
    expect(deriveStatus("building", { postponed: true })).toBe("backlog")
    // postponed beats blocked
    expect(deriveStatus("building", { blocked: true, postponed: true })).toBe("backlog")
    // a verified job can still be postponed/blocked if reopened
    expect(deriveStatus("verified", { blocked: true })).toBe("blocked")
  })
})

describe("parseMilestones", () => {
  it("parses a JSON string", () => {
    const raw = JSON.stringify(initialMilestones(NOW, "Claude"))
    expect(parseMilestones(raw)?.current).toBe("requested")
  })

  it("parses an object", () => {
    expect(parseMilestones(initialMilestones(NOW))?.current).toBe("requested")
  })

  it("returns null for junk / null / bad JSON / missing current", () => {
    expect(parseMilestones(null)).toBeNull()
    expect(parseMilestones("not json")).toBeNull()
    expect(parseMilestones({})).toBeNull()
  })

  it("is lenient on stage keys (custom sets use arbitrary keys)", () => {
    // 'nope' is a valid custom stage key from parse's view — set-membership is a UI concern.
    expect(parseMilestones({ current: "nope" })?.current).toBe("nope")
  })

  it("drops only truly malformed history entries (null, non-object, missing stage)", () => {
    const m = parseMilestones({
      current: "building",
      history: [{ stage: "requested", at: NOW }, { stage: "custom_stage", at: LATER }, null, 5, { at: NOW }],
    })
    expect(m?.history.map((h) => h.stage)).toEqual(["requested", "custom_stage"])
  })
})

describe("by-stage content mapping", () => {
  it("maps the three rich stages to fields; tail stages have none", () => {
    expect(STAGE_FIELD.requested).toBe("description")
    expect(STAGE_FIELD.investigated).toBe("findings")
    expect(STAGE_FIELD.plan_approved).toBe("plan")
    expect(STAGE_FIELD.building).toBeUndefined()
    expect(STAGE_FIELD.verified).toBeUndefined()
  })

})

describe("stage sets", () => {
  const BUG_SET: StageSet = {
    key: "bugfix",
    label: "Bug",
    stages: [
      { key: "reported", label: "Reported", lane: "todo", field: "description" },
      { key: "reproduced", label: "Reproduced", lane: "in_progress", field: "findings" },
      { key: "root_cause", label: "Root cause", lane: "in_progress" },
      { key: "fixing", label: "Fixing", lane: "in_progress" },
      { key: "verified", label: "Verified", lane: "done" },
    ],
  }

  it("DEFAULT_STAGE_SET has the seven standard stages, requested=todo verified=done", () => {
    expect(DEFAULT_STAGE_SET.stages.map((s) => s.key)).toEqual(MILESTONE_STAGES as unknown as string[])
    expect(stageDef(DEFAULT_STAGE_SET, "requested")?.lane).toBe("todo")
    expect(stageDef(DEFAULT_STAGE_SET, "verified")?.lane).toBe("done")
  })

  it("deriveStatusForSet maps a custom set's stage lanes, overrides win", () => {
    expect(deriveStatusForSet(BUG_SET, "reported")).toBe("todo")
    expect(deriveStatusForSet(BUG_SET, "fixing")).toBe("in_progress")
    expect(deriveStatusForSet(BUG_SET, "verified")).toBe("done")
    expect(deriveStatusForSet(BUG_SET, "fixing", { blocked: true })).toBe("blocked")
    expect(deriveStatusForSet(BUG_SET, "fixing", { postponed: true })).toBe("backlog")
    // unknown stage → safe middle
    expect(deriveStatusForSet(BUG_SET, "ghost")).toBe("in_progress")
  })

  it("isKeyInSet + labelForStage", () => {
    expect(isKeyInSet(BUG_SET, "root_cause")).toBe(true)
    expect(isKeyInSet(BUG_SET, "requested")).toBe(false)
    expect(labelForStage(BUG_SET, "root_cause")).toBe("Root cause")
    // unknown key → prettified fallback
    expect(labelForStage(BUG_SET, "some_new_stage")).toBe("Some New Stage")
  })

  it("notesForStage returns non-empty notes for a stage, across repeats", () => {
    const ms = {
      current: "building" as const,
      history: [
        { stage: "building" as const, at: NOW, note: "first build" },
        { stage: "qa_passed" as const, at: LATER, note: "  " },
        { stage: "building" as const, at: LATER, note: "back after QA fail" },
        { stage: "building" as const, at: LATER },
      ],
    }
    expect(notesForStage(ms, "building")).toEqual(["first build", "back after QA fail"])
    expect(notesForStage(ms, "qa_passed")).toEqual([]) // blank note dropped
    expect(notesForStage(null, "building")).toEqual([])
  })
})
