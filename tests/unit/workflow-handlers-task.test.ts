/**
 * Unit tests for the 5 task.* generic handlers.
 *
 * These handlers are mostly pure logic over their params + the task row in
 * ctx. We test validation paths (the bad-input cases) without mocking and
 * the happy path by constructing a minimal HandlerContext.
 *
 * Handlers that touch the DB (task.waiting_with_optional_message — portal
 * insert + notifications; task.reassign — rollback via updateTask) are
 * covered for their validation paths here; full DB-side behavior lives in
 * the integration tests that arrive with Slice 4.
 */

import { describe, expect, it } from "vitest"

import { taskFlagBlocked } from "@/lib/tasks/workflow-handlers/task-flag-blocked"
import { taskCancel } from "@/lib/tasks/workflow-handlers/task-cancel"
import { taskSnooze } from "@/lib/tasks/workflow-handlers/task-snooze"
import { taskReassign } from "@/lib/tasks/workflow-handlers/task-reassign"
import { taskWaitingWithOptionalMessage } from "@/lib/tasks/workflow-handlers/task-waiting-with-optional-message"
import type {
  HandlerContext,
  TaskRow,
  WorkflowActionDefinition,
  WorkflowSnapshot,
} from "@/lib/tasks/types"

function makeAction(overrides: Partial<WorkflowActionDefinition> = {}): WorkflowActionDefinition {
  return {
    slug: "test_action",
    label_admin: "Test Action",
    permission: { role_in: ["admin", "team"] },
    handler: "test.handler",
    on_success_status: "Waiting",
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    slug: "test_workflow",
    version: 1,
    label_admin: "Test Workflow",
    permission: { role_in: ["admin", "team"] },
    actions: [makeAction()],
    ...overrides,
  }
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    task_title: "Test task",
    assigned_to: "Luca",
    status: "To Do",
    priority: "Normal",
    due_date: null,
    category: null,
    description: null,
    created_by: null,
    completed_date: null,
    notified: false,
    account_id: null,
    deal_id: null,
    service_id: null,
    notes: null,
    airtable_id: null,
    zoho_task_id: null,
    hubspot_id: null,
    created_at: "2026-05-15T00:00:00Z",
    updated_at: "2026-05-15T00:00:00Z",
    stage_order: null,
    delivery_id: null,
    contact_id: null,
    attachments: [],
    workflow_slug: "test_workflow",
    workflow_snapshot: {} as Record<string, unknown>,
    task_meta: {},
    ...overrides,
  } as TaskRow
}

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    task: makeTask(),
    workflow: makeSnapshot(),
    action: makeAction(),
    params: {},
    actor: { id: "actor-uuid" } as HandlerContext["actor"],
    idempotencyKey: "test-key-1",
    serviceCatalog: null,
    supabase: {} as HandlerContext["supabase"],
    mode: "execute",
    ...overrides,
  }
}

describe("task.flag_blocked", () => {
  it("fails when 'note' param is missing", async () => {
    const result = await taskFlagBlocked(makeCtx({ params: {} }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_PARAM_NOTE")
  })

  it("fails when 'note' is whitespace-only", async () => {
    const result = await taskFlagBlocked(makeCtx({ params: { note: "   " } }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_PARAM_NOTE")
  })

  it("succeeds with a real note and stamps task_meta", async () => {
    const result = await taskFlagBlocked(makeCtx({ params: { note: "Wrong DOB" } }))
    expect(result.success).toBe(true)
    expect(result.task_meta_patch?.last_block_note).toBe("Wrong DOB")
    expect(result.task_meta_patch?.last_blocked_at).toBeDefined()
    expect(result.side_effects).toHaveLength(1)
  })

  it("preview mode does not record side_effects", async () => {
    const result = await taskFlagBlocked(makeCtx({ params: { note: "x" }, mode: "preview" }))
    expect(result.success).toBe(true)
    expect(result.side_effects).toEqual([])
  })
})

describe("task.cancel", () => {
  it("succeeds with no params", async () => {
    const result = await taskCancel(makeCtx({ params: {} }))
    expect(result.success).toBe(true)
    expect(result.task_meta_patch?.cancelled_at).toBeDefined()
  })

  it("captures a reason when supplied", async () => {
    const result = await taskCancel(makeCtx({ params: { reason: "Duplicate of #42" } }))
    expect(result.success).toBe(true)
    expect(result.task_meta_patch?.cancellation_reason).toBe("Duplicate of #42")
  })
})

describe("task.snooze", () => {
  it("fails when until_date is missing", async () => {
    const result = await taskSnooze(makeCtx({ params: {} }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("INVALID_UNTIL_DATE")
  })

  it("fails when until_date is not ISO-formatted", async () => {
    const result = await taskSnooze(makeCtx({ params: { until_date: "tomorrow" } }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("INVALID_UNTIL_DATE")
  })

  it("fails when until_date is today or earlier", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
    const result = await taskSnooze(makeCtx({ params: { until_date: yesterday } }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("UNTIL_DATE_NOT_FUTURE")
  })

  it("succeeds with a future date and sets task_patch.due_date", async () => {
    const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
    const result = await taskSnooze(makeCtx({ params: { until_date: future } }))
    expect(result.success).toBe(true)
    expect(result.task_patch?.due_date).toBe(future)
    expect(result.task_meta_patch?.snooze_until).toBe(future)
  })
})

describe("task.reassign", () => {
  it("fails when assigned_to is missing", async () => {
    const result = await taskReassign(makeCtx({ params: {} }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_ASSIGNED_TO")
  })

  it("fails when re-assigning to the same person", async () => {
    const result = await taskReassign(
      makeCtx({ params: { assigned_to: "Luca" }, task: makeTask({ assigned_to: "Luca" }) }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("SAME_ASSIGNEE")
  })

  it("succeeds with a new assignee and records the previous one", async () => {
    const result = await taskReassign(
      makeCtx({ params: { assigned_to: "Antonio" }, task: makeTask({ assigned_to: "Luca" }) }),
    )
    expect(result.success).toBe(true)
    expect(result.task_patch?.assigned_to).toBe("Antonio")
    expect(result.task_meta_patch?.previous_assignee).toBe("Luca")
    expect(result.side_effects[0].rollback).toBeDefined()
  })
})

describe("task.waiting_with_optional_message", () => {
  it("succeeds with no message — status-change only, no recipient required", async () => {
    const result = await taskWaitingWithOptionalMessage(makeCtx({ params: {} }))
    expect(result.success).toBe(true)
    expect(result.side_effects[0].kind).toBe("task.waiting")
  })

  it("fails when a message is supplied but task has no recipient", async () => {
    const result = await taskWaitingWithOptionalMessage(
      makeCtx({
        params: { client_message_en: "Please send the docs" },
        task: makeTask({ contact_id: null, account_id: null }),
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NO_RECIPIENT")
  })
})
