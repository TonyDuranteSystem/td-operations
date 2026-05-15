/**
 * Per-workflow task_meta schema map — Slice 1.
 *
 * At Slice 1 the schema map ships empty. Slice 4 adds itin_review_v1.
 * This test pins the empty-map behavior and the API contract.
 */

import { describe, expect, it } from "vitest"
import {
  WORKFLOW_SCHEMAS,
  getRegisteredSchemaNames,
  getWorkflowSchema,
} from "@/lib/tasks/workflow-schemas"

describe("workflow-schemas — current registered set", () => {
  it("WORKFLOW_SCHEMAS contains itin_review_v1 (Slice 4)", () => {
    expect(Object.keys(WORKFLOW_SCHEMAS)).toContain("itin_review_v1")
  })

  it("getRegisteredSchemaNames returns the registered set", () => {
    const names = getRegisteredSchemaNames()
    expect(Array.isArray(names)).toBe(true)
    expect(names).toContain("itin_review_v1")
  })

  it("getWorkflowSchema returns null for null / undefined / empty / unregistered", () => {
    expect(getWorkflowSchema(null)).toBeNull()
    expect(getWorkflowSchema(undefined)).toBeNull()
    expect(getWorkflowSchema("")).toBeNull()
    expect(getWorkflowSchema("does_not_exist_v1")).toBeNull()
  })

  it("getWorkflowSchema returns itin_review_v1 schema when requested", () => {
    const schema = getWorkflowSchema("itin_review_v1")
    expect(schema).not.toBeNull()
    expect(typeof schema?.safeParse).toBe("function")
  })
})

describe("itin_review_v1 schema", () => {
  const validMeta = {
    submission_id: "550e8400-e29b-41d4-a716-446655440000",
    drive_folder_id: "drive-folder-id-abc",
    attachments: [
      { kind: "w7", file_id: "f1", file_name: "W-7.pdf", mime_type: "application/pdf" },
      { kind: "1040nr", file_id: "f2", file_name: "1040NR.pdf", mime_type: "application/pdf" },
      { kind: "schedule_oi", file_id: "f3", file_name: "SchOI.pdf", mime_type: "application/pdf" },
    ],
    generated_at: "2026-05-15T12:00:00.000Z",
    client_language: "en",
    client_email: "client@example.com",
    client_first_name: "John",
    client_last_name: "Doe",
  }

  it("accepts a valid itin_review_v1 meta shape", () => {
    const schema = getWorkflowSchema("itin_review_v1")!
    const out = schema.safeParse(validMeta)
    expect(out.success).toBe(true)
  })

  it("rejects task_meta with fewer than 3 attachments", () => {
    const schema = getWorkflowSchema("itin_review_v1")!
    const bad = { ...validMeta, attachments: validMeta.attachments.slice(0, 2) }
    expect(schema.safeParse(bad).success).toBe(false)
  })

  it("rejects an attachment with a non-PDF mime type", () => {
    const schema = getWorkflowSchema("itin_review_v1")!
    const bad = {
      ...validMeta,
      attachments: [
        ...validMeta.attachments.slice(0, 2),
        { ...validMeta.attachments[2], mime_type: "image/png" },
      ],
    }
    expect(schema.safeParse(bad).success).toBe(false)
  })

  it("rejects an unknown attachment kind", () => {
    const schema = getWorkflowSchema("itin_review_v1")!
    const bad = {
      ...validMeta,
      attachments: [
        { ...validMeta.attachments[0], kind: "unknown_kind" },
        ...validMeta.attachments.slice(1),
      ],
    }
    expect(schema.safeParse(bad).success).toBe(false)
  })

  it("rejects an invalid client_email", () => {
    const schema = getWorkflowSchema("itin_review_v1")!
    expect(schema.safeParse({ ...validMeta, client_email: "not-an-email" }).success).toBe(false)
  })

  it("rejects an empty client_first_name", () => {
    const schema = getWorkflowSchema("itin_review_v1")!
    expect(schema.safeParse({ ...validMeta, client_first_name: "" }).success).toBe(false)
  })

  it("rejects an invalid client_language", () => {
    const schema = getWorkflowSchema("itin_review_v1")!
    expect(schema.safeParse({ ...validMeta, client_language: "fr" }).success).toBe(false)
  })
})
