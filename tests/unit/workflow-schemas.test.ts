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

describe("workflow-schemas — Slice 1 (empty)", () => {
  it("WORKFLOW_SCHEMAS is empty at Slice 1", () => {
    // Slice 4 will add itin_review_v1. Update the expectation when it does.
    expect(Object.keys(WORKFLOW_SCHEMAS)).toEqual([])
  })

  it("getRegisteredSchemaNames returns an array (empty at Slice 1)", () => {
    const names = getRegisteredSchemaNames()
    expect(Array.isArray(names)).toBe(true)
    expect(names).toEqual([])
  })

  it("getWorkflowSchema returns null for null / undefined / empty / unregistered", () => {
    expect(getWorkflowSchema(null)).toBeNull()
    expect(getWorkflowSchema(undefined)).toBeNull()
    expect(getWorkflowSchema("")).toBeNull()
    expect(getWorkflowSchema("does_not_exist_v1")).toBeNull()
  })
})
