/**
 * Unit tests for the 9 chain.* generic handlers — validation paths.
 *
 * The "happy path" for these handlers calls real helpers (advanceStage,
 * sendEmail, updateContact, supabase queries). Mocking those in unit tests
 * is high-effort and low-yield — the helpers have their own tests. Instead
 * we cover the input-validation surface of each chain handler (the part
 * that's pure logic) here, plus the deterministic behavior of the two
 * NOT_IMPLEMENTED stubs.
 *
 * Full end-to-end behavior lands with Slice 4 integration tests against
 * the sandbox dispatcher.
 */

import { describe, expect, it } from "vitest"

import { chainAwaitClientAction } from "@/lib/tasks/workflow-handlers/chain-await-client-action"
import { chainSpawnNextWorkflow } from "@/lib/tasks/workflow-handlers/chain-spawn-next-workflow"
import { chainSendEmail } from "@/lib/tasks/workflow-handlers/chain-send-email"
import { chainSendClientMessage } from "@/lib/tasks/workflow-handlers/chain-send-client-message"
import { chainAdvanceSdStage } from "@/lib/tasks/workflow-handlers/chain-advance-sd-stage"
import { chainUpdateContactField } from "@/lib/tasks/workflow-handlers/chain-update-contact-field"
import { chainUpdateAccountField } from "@/lib/tasks/workflow-handlers/chain-update-account-field"
import { chainUploadDocument } from "@/lib/tasks/workflow-handlers/chain-upload-document"
import { chainSendForSignature } from "@/lib/tasks/workflow-handlers/chain-send-for-signature"
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
    workflow_snapshot: {},
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

describe("chain.await_client_action", () => {
  it("succeeds even with no params", async () => {
    const result = await chainAwaitClientAction(makeCtx({ params: {} }))
    expect(result.success).toBe(true)
    expect(result.task_meta_patch?.awaiting_since).toBeDefined()
  })

  it("captures awaiting_note when supplied", async () => {
    const result = await chainAwaitClientAction(
      makeCtx({ params: { awaiting_note: "Waiting on IRS processing" } }),
    )
    expect(result.success).toBe(true)
    expect(result.task_meta_patch?.awaiting_note).toBe("Waiting on IRS processing")
  })
})

describe("chain.spawn_next_workflow", () => {
  it("fails when neither params nor action.handler_params supply workflow_slug", async () => {
    const result = await chainSpawnNextWorkflow(makeCtx({ params: {} }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_WORKFLOW_SLUG")
  })

  it("reads workflow_slug from params and sets spawn_task", async () => {
    const result = await chainSpawnNextWorkflow(
      makeCtx({ params: { workflow_slug: "lease_review", task_meta: { foo: "bar" } } }),
    )
    expect(result.success).toBe(true)
    expect(result.spawn_task?.workflow_slug).toBe("lease_review")
    expect(result.spawn_task?.task_meta).toEqual({ foo: "bar" })
    expect(result.transition).toBe("lease_review")
  })

  it("reads workflow_slug from action.handler_params when params has none", async () => {
    const result = await chainSpawnNextWorkflow(
      makeCtx({
        params: {},
        action: makeAction({ handler_params: { workflow_slug: "static_next" } }),
      }),
    )
    expect(result.success).toBe(true)
    expect(result.spawn_task?.workflow_slug).toBe("static_next")
  })
})

describe("chain.send_email", () => {
  it("fails when required fields missing", async () => {
    const r1 = await chainSendEmail(makeCtx({ params: { subject: "x", body_html: "y" } }))
    expect(r1.error?.code).toBe("MISSING_EMAIL_FIELDS")
    const r2 = await chainSendEmail(makeCtx({ params: { to: "x@y.com", body_html: "y" } }))
    expect(r2.error?.code).toBe("MISSING_EMAIL_FIELDS")
    const r3 = await chainSendEmail(makeCtx({ params: { to: "x@y.com", subject: "x" } }))
    expect(r3.error?.code).toBe("MISSING_EMAIL_FIELDS")
  })
})

describe("chain.send_client_message", () => {
  it("fails when neither body_en nor body_it is supplied", async () => {
    const result = await chainSendClientMessage(makeCtx({ params: {} }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_MESSAGE")
  })

  it("fails when task has no recipient (contact_id and account_id both null)", async () => {
    const result = await chainSendClientMessage(
      makeCtx({
        params: { body_en: "Hello" },
        task: makeTask({ contact_id: null, account_id: null }),
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NO_RECIPIENT")
  })
})

describe("chain.advance_sd_stage", () => {
  it("fails when parent task has no delivery_id", async () => {
    const result = await chainAdvanceSdStage(makeCtx({ params: { target_stage: "Done" } }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NO_DELIVERY")
  })
})

describe("chain.update_contact_field", () => {
  it("fails when no field is set in handler_params", async () => {
    const result = await chainUpdateContactField(makeCtx({ params: { value: "it" } }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_FIELD")
  })

  it("fails when field is on the forbidden list", async () => {
    const result = await chainUpdateContactField(
      makeCtx({
        params: { value: "active" },
        action: makeAction({ handler_params: { field: "portal_tier" } }),
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("FORBIDDEN_FIELD")
  })

  it("fails when value is missing from both params and handler_params", async () => {
    const result = await chainUpdateContactField(
      makeCtx({
        params: {},
        action: makeAction({ handler_params: { field: "language" } }),
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_VALUE")
  })

  it("fails when no contact target exists", async () => {
    const result = await chainUpdateContactField(
      makeCtx({
        params: { value: "it" },
        action: makeAction({ handler_params: { field: "language" } }),
        task: makeTask({ contact_id: null }),
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NO_CONTACT")
  })
})

describe("chain.update_account_field", () => {
  it("fails when no field is set", async () => {
    const result = await chainUpdateAccountField(makeCtx({ params: { value: "x" } }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("MISSING_FIELD")
  })

  it("fails when field is on the forbidden list", async () => {
    const result = await chainUpdateAccountField(
      makeCtx({
        params: { value: "active" },
        action: makeAction({ handler_params: { field: "portal_tier" } }),
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("FORBIDDEN_FIELD")
  })

  it("fails when no account target exists", async () => {
    const result = await chainUpdateAccountField(
      makeCtx({
        params: { value: "x" },
        action: makeAction({ handler_params: { field: "company_name" } }),
        task: makeTask({ account_id: null }),
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NO_ACCOUNT")
  })
})

describe("chain.upload_document (Slice 2 stub)", () => {
  it("returns NOT_IMPLEMENTED until the helper is extracted", async () => {
    const result = await chainUploadDocument(makeCtx())
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NOT_IMPLEMENTED")
  })
})

describe("chain.send_for_signature (Slice 2 stub)", () => {
  it("returns NOT_IMPLEMENTED until the helper is extracted", async () => {
    const result = await chainSendForSignature(makeCtx())
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NOT_IMPLEMENTED")
  })
})
