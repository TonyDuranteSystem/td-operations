/**
 * WorkflowSnapshot Zod schema — validates the shape pinned into
 * tasks.workflow_snapshot at task creation, and read back by the dispatcher.
 *
 * A corrupt snapshot must fail loud rather than crash the handler.
 */

import { describe, expect, it } from "vitest"
import {
  WorkflowSnapshotSchema,
  parseWorkflowSnapshot,
} from "@/lib/tasks/workflow-snapshot-schema"

function buildValidSnapshot() {
  return {
    slug: "itin_review",
    version: 1,
    label_admin: "Review ITIN forms",
    permission: { role_in: ["admin", "team"] },
    actions: [
      {
        slug: "approve_send",
        label_admin: "Approve & Send to Client",
        primary: true,
        permission: { role_in: ["admin", "team"] },
        handler: "itin.approve_and_send",
        on_success_status: "Done",
      },
    ],
  }
}

describe("WorkflowSnapshotSchema — happy path", () => {
  it("accepts a minimal valid snapshot", () => {
    const ok = WorkflowSnapshotSchema.safeParse(buildValidSnapshot())
    expect(ok.success).toBe(true)
  })

  it("accepts a snapshot with sla, attachment_template, on_success_meta", () => {
    const s = buildValidSnapshot()
    s.actions.push({
      slug: "needs_fix",
      label_admin: "Needs Fix",
      // @ts-expect-error testing the shape passes through Zod, not TS
      requires_input: { field: "note", required: true },
      permission: { role_in: ["admin", "team"] },
      handler: "task.flag_blocked",
      on_success_status: "Waiting",
      on_success_meta: { workflow_state: "Needs Fix" },
    })
    // @ts-expect-error optional fields not in the minimal helper type
    s.attachment_template = "pdf_list"
    // @ts-expect-error
    s.sla = { warn_hours: 24, escalate_hours: 72, escalate_to: "Antonio" }
    expect(WorkflowSnapshotSchema.safeParse(s).success).toBe(true)
  })

  it("parseWorkflowSnapshot returns a typed snapshot on success", () => {
    const parsed = parseWorkflowSnapshot(buildValidSnapshot())
    expect(parsed.slug).toBe("itin_review")
    expect(parsed.actions).toHaveLength(1)
    expect(parsed.actions[0].on_success_status).toBe("Done")
  })
})

describe("WorkflowSnapshotSchema — rejection cases", () => {
  it("rejects an empty slug", () => {
    const s = buildValidSnapshot()
    s.slug = ""
    expect(WorkflowSnapshotSchema.safeParse(s).success).toBe(false)
  })

  it("rejects a non-positive version", () => {
    const s = buildValidSnapshot()
    s.version = 0
    expect(WorkflowSnapshotSchema.safeParse(s).success).toBe(false)
  })

  it("rejects an unknown CrmRole in permission", () => {
    const s = buildValidSnapshot()
    // 'partner' is a portal role, not a CRM role — Slice 0 Decision B
    s.permission.role_in = ["partner" as never]
    expect(WorkflowSnapshotSchema.safeParse(s).success).toBe(false)
  })

  it("rejects an action with on_success_status outside the enum", () => {
    const s = buildValidSnapshot()
    s.actions[0].on_success_status = "Blocked" as never
    expect(WorkflowSnapshotSchema.safeParse(s).success).toBe(false)
  })

  it("rejects an action missing required fields", () => {
    const s = buildValidSnapshot()
    // @ts-expect-error intentionally malformed for the test
    s.actions[0] = { slug: "x" }
    expect(WorkflowSnapshotSchema.safeParse(s).success).toBe(false)
  })

  it("rejects a snapshot with zero actions", () => {
    const s = buildValidSnapshot()
    s.actions = []
    expect(WorkflowSnapshotSchema.safeParse(s).success).toBe(false)
  })

  it("parseWorkflowSnapshot throws on bad input", () => {
    expect(() => parseWorkflowSnapshot({ slug: "x" })).toThrow()
    expect(() => parseWorkflowSnapshot(null)).toThrow()
    expect(() => parseWorkflowSnapshot(undefined)).toThrow()
  })
})
