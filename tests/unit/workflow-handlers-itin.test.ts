/**
 * Unit tests for the Slice 4 ITIN-specific handlers.
 *
 * These handlers compose multiple DB-touching primitives (sendEmail,
 * advanceStage, portal_messages insert, etc.). Full end-to-end behavior
 * is verified by manual sandbox QA after deploy. Here we cover what we
 * can test in node-only vitest: preview-mode round-trips (no side
 * effects fire), and the shape of the returned HandlerResult.
 *
 * The DB-touching execute paths are NOT mocked exhaustively — that level
 * of mocking trades real bug-catching surface for false confidence. The
 * sandbox integration round-trip at Slice 4 deploy is the truth source.
 */

import { describe, expect, it } from "vitest"
import { itinApproveAndSend } from "@/lib/tasks/workflow-handlers/itin-approve-and-send"
import { itinRecallAndRecorrect } from "@/lib/tasks/workflow-handlers/itin-recall-and-recorrect"
import type {
  HandlerContext,
  TaskRow,
  WorkflowActionDefinition,
  WorkflowSnapshot,
} from "@/lib/tasks/types"

function makeMeta() {
  return {
    submission_id: "550e8400-e29b-41d4-a716-446655440000",
    drive_folder_id: "drive-folder",
    attachments: [
      { kind: "w7", file_id: "fid-w7", file_name: "W-7.pdf", mime_type: "application/pdf" },
      { kind: "1040nr", file_id: "fid-nr", file_name: "1040NR.pdf", mime_type: "application/pdf" },
      { kind: "schedule_oi", file_id: "fid-oi", file_name: "SchOI.pdf", mime_type: "application/pdf" },
    ],
    generated_at: "2026-05-15T12:00:00.000Z",
    client_language: "en" as const,
    client_email: "client@example.com",
    client_first_name: "John",
    client_last_name: "Doe",
  }
}

function makeAction(slug: string): WorkflowActionDefinition {
  return {
    slug,
    label_admin: slug,
    permission: { role_in: ["admin", "team"] },
    handler: slug === "approve_send" ? "itin.approve_and_send" : "itin.recall_and_recorrect",
    on_success_status: slug === "approve_send" ? "Done" : "Cancelled",
  }
}

function makeSnapshot(): WorkflowSnapshot {
  return {
    slug: "itin_review",
    version: 1,
    label_admin: "Review ITIN forms",
    permission: { role_in: ["admin", "team"] },
    auto_topic: "ITIN",
    actions: [makeAction("approve_send"), makeAction("recall")],
  }
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-id",
    task_title: "Review ITIN documents — John Doe",
    assigned_to: "Luca",
    status: "To Do",
    priority: "High",
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
    contact_id: "contact-id",
    attachments: [],
    workflow_slug: "itin_review",
    workflow_snapshot: {} as Record<string, unknown>,
    task_meta: makeMeta() as unknown as Record<string, unknown>,
    ...overrides,
  } as TaskRow
}

function makeCtx(action: WorkflowActionDefinition, taskOverrides: Partial<TaskRow> = {}): HandlerContext {
  return {
    task: makeTask(taskOverrides),
    workflow: makeSnapshot(),
    action,
    params: {},
    actor: { id: "actor-uuid" } as HandlerContext["actor"],
    idempotencyKey: "test-key",
    serviceCatalog: null,
    supabase: {} as HandlerContext["supabase"],
    mode: "preview",
  }
}

describe("itin.approve_and_send — preview mode", () => {
  it("returns preview payload with email body + portal message + sd stage change", async () => {
    const ctx = makeCtx(makeAction("approve_send"))
    const result = await itinApproveAndSend(ctx)
    expect(result.success).toBe(true)
    expect(result.preview).toBeDefined()
    expect(result.preview?.email_html).toContain("ITIN")
    expect(result.preview?.email_html).toContain("John")
    expect(result.preview?.portal_message).toContain("John")
    expect(result.preview?.sd_stage_change).toContain("Client Signing")
  })

  it("preview produces no actual side effects (all entries are .preview markers)", async () => {
    const ctx = makeCtx(makeAction("approve_send"))
    const result = await itinApproveAndSend(ctx)
    expect(result.side_effects.every((se) => se.kind.endsWith(".preview"))).toBe(true)
  })

  it("renders Italian email when client_language is 'it'", async () => {
    const ctx = makeCtx(makeAction("approve_send"))
    ctx.task.task_meta = { ...makeMeta(), client_language: "it" } as unknown as Record<string, unknown>
    const result = await itinApproveAndSend(ctx)
    expect(result.preview?.email_html).toMatch(/Ciao John/)
    expect(result.preview?.portal_message).toMatch(/Ciao John/)
  })

  it("filters out passport_copy attachments from the email drive_file_ids list", async () => {
    // The handler only attaches W-7, 1040-NR, Schedule OI to the email —
    // passport copies should NOT be attached (they go separately or are
    // referenced as part of the CAA package).
    const meta = makeMeta()
    const attachmentsWithPassport = [
      ...meta.attachments,
      {
        kind: "passport_copy" as const,
        file_id: "fid-passport",
        file_name: "passport.pdf",
        mime_type: "application/pdf" as const,
      },
    ]
    const ctx = makeCtx(makeAction("approve_send"))
    ctx.task.task_meta = { ...meta, attachments: attachmentsWithPassport } as unknown as Record<string, unknown>
    const result = await itinApproveAndSend(ctx)
    // The preview kind for email says "Would email ... with 3 PDFs" — 3 not 4.
    const emailPreviewEntry = result.side_effects.find((se) => se.kind === "email.preview")
    expect(emailPreviewEntry?.detail).toContain("3 PDFs")
  })
})

describe("itin.recall_and_recorrect — preview mode", () => {
  it("returns a preview payload describing the recall side effects", async () => {
    const ctx = makeCtx(makeAction("recall"))
    const result = await itinRecallAndRecorrect(ctx)
    expect(result.success).toBe(true)
    expect(result.preview?.sd_stage_change).toContain("Document Preparation")
    expect(result.side_effects.every((se) => se.kind.endsWith(".preview"))).toBe(true)
  })
})
