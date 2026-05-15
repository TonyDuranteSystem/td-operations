/**
 * WorkflowTaskCard — pure-logic helpers.
 *
 * Tests the two exported helpers (filterActionsByRole, splitPrimary) without
 * touching React. Full component rendering is verified by manual sandbox
 * browser QA at Slice 4 when real workflow tasks exist.
 */

import { describe, expect, it } from "vitest"
import { filterActionsByRole, splitPrimary } from "@/lib/tasks/workflow-task-card-logic"
import type { WorkflowActionDefinition } from "@/lib/tasks/types"

function makeAction(overrides: Partial<WorkflowActionDefinition> = {}): WorkflowActionDefinition {
  return {
    slug: overrides.slug ?? "act",
    label_admin: overrides.label_admin ?? "Action",
    permission: overrides.permission ?? { role_in: ["admin", "team"] },
    handler: overrides.handler ?? "task.cancel",
    on_success_status: overrides.on_success_status ?? "Done",
    ...overrides,
  }
}

describe("filterActionsByRole", () => {
  it("returns only actions whose role_in includes the viewer's role", () => {
    const actions = [
      makeAction({ slug: "approve", permission: { role_in: ["admin"] } }),
      makeAction({ slug: "needs_fix", permission: { role_in: ["admin", "team"] } }),
      makeAction({ slug: "team_only", permission: { role_in: ["team"] } }),
    ]
    expect(filterActionsByRole(actions, "admin").map((a) => a.slug)).toEqual([
      "approve",
      "needs_fix",
    ])
    expect(filterActionsByRole(actions, "team").map((a) => a.slug)).toEqual([
      "needs_fix",
      "team_only",
    ])
  })

  it("returns empty array when role matches nothing", () => {
    const actions = [makeAction({ permission: { role_in: ["admin"] } })]
    expect(filterActionsByRole(actions, "team")).toEqual([])
  })

  it("returns empty array on empty input", () => {
    expect(filterActionsByRole([], "admin")).toEqual([])
  })
})

describe("splitPrimary", () => {
  it("returns nulls when no actions", () => {
    expect(splitPrimary([])).toEqual({ primary: null, rest: [] })
  })

  it("treats the explicit primary action as primary even if it isn't first", () => {
    const a = makeAction({ slug: "a" })
    const b = makeAction({ slug: "b", primary: true })
    const c = makeAction({ slug: "c" })
    const out = splitPrimary([a, b, c])
    expect(out.primary?.slug).toBe("b")
    expect(out.rest.map((x) => x.slug)).toEqual(["a", "c"])
  })

  it("falls back to first action when none is explicitly primary", () => {
    const a = makeAction({ slug: "a" })
    const b = makeAction({ slug: "b" })
    const out = splitPrimary([a, b])
    expect(out.primary?.slug).toBe("a")
    expect(out.rest.map((x) => x.slug)).toEqual(["b"])
  })

  it("returns just primary when only one action exists", () => {
    const a = makeAction({ slug: "a" })
    const out = splitPrimary([a])
    expect(out.primary?.slug).toBe("a")
    expect(out.rest).toEqual([])
  })
})
