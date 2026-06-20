import { describe, it, expect } from "vitest"
import { decideCodeTaskAction } from "@/lib/code-tasks/actions"

const done = (branch: string | null = "code-task/abc-x") => ({ status: "done", code_branch: branch })

describe("decideCodeTaskAction — promote", () => {
  it("queues a promote for a finished task with a review branch", () => {
    expect(decideCodeTaskAction(done("code-task/abc-x"), "promote")).toEqual({
      ok: true, kind: "queue_promote", branch: "code-task/abc-x",
    })
  })
  it("rejects promote when there is no review branch", () => {
    const d = decideCodeTaskAction(done(null), "promote")
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe(409)
  })
  it("rejects promote when the task is not finished", () => {
    expect(decideCodeTaskAction({ status: "processing", code_branch: "code-task/x" }, "promote").ok).toBe(false)
  })
  it("rejects promote on a promotion task itself", () => {
    expect(decideCodeTaskAction({ status: "done", code_branch: null, is_promote: true }, "promote").ok).toBe(false)
  })
})

describe("decideCodeTaskAction — retry", () => {
  it("re-queues a failed task", () => {
    expect(decideCodeTaskAction({ status: "failed", code_branch: null }, "retry")).toEqual({ ok: true, kind: "requeue" })
  })
  it("re-queues a cancelled task", () => {
    expect(decideCodeTaskAction({ status: "cancelled", code_branch: null }, "retry")).toEqual({ ok: true, kind: "requeue" })
  })
  it("rejects retry on a done or processing task", () => {
    expect(decideCodeTaskAction({ status: "done", code_branch: "b" }, "retry").ok).toBe(false)
    expect(decideCodeTaskAction({ status: "processing", code_branch: null }, "retry").ok).toBe(false)
  })
})

describe("decideCodeTaskAction — cancel", () => {
  it("cancels a pending (not-yet-claimed) task", () => {
    expect(decideCodeTaskAction({ status: "pending", code_branch: null }, "cancel")).toEqual({ ok: true, kind: "mark_cancelled" })
  })
  it("refuses to hard-cancel a live processing task (points to End Session)", () => {
    const d = decideCodeTaskAction({ status: "processing", code_branch: null }, "cancel")
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toMatch(/End Session/i)
  })
  it("rejects cancel on a finished task", () => {
    expect(decideCodeTaskAction({ status: "done", code_branch: "b" }, "cancel").ok).toBe(false)
  })
})

describe("decideCodeTaskAction — dismiss", () => {
  it("dismisses a finished/failed task", () => {
    expect(decideCodeTaskAction({ status: "done", code_branch: "b" }, "dismiss")).toEqual({ ok: true, kind: "mark_dismissed" })
    expect(decideCodeTaskAction({ status: "failed", code_branch: null }, "dismiss").ok).toBe(true)
  })
  it("refuses to dismiss an active task", () => {
    expect(decideCodeTaskAction({ status: "processing", code_branch: null }, "dismiss").ok).toBe(false)
    expect(decideCodeTaskAction({ status: "pending", code_branch: null }, "dismiss").ok).toBe(false)
  })
})

describe("decideCodeTaskAction — unknown", () => {
  it("rejects an unknown action", () => {
    // @ts-expect-error testing invalid input
    expect(decideCodeTaskAction({ status: "done", code_branch: "b" }, "frobnicate").ok).toBe(false)
  })
})
