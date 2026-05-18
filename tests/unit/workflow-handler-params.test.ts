/**
 * Tests for the handler param-schema registry. Asserts:
 *   - Every registered handler-function in workflow-registry.ts has a
 *     corresponding param schema (no drift).
 *   - Each "rich" handler's schema accepts the shape its real catalog rows
 *     use today (regression guard — if I tighten a schema and break an
 *     active catalog row, the test fails).
 *   - Each "rich" handler's schema rejects obviously-wrong shapes (catch
 *     editor bugs at validation time).
 *   - Empty-schema handlers reject any extra keys (strict mode).
 */

import { describe, it, expect } from "vitest"
import {
  getHandlerParamSchema,
  getRegisteredHandlerParamSchemaSlugs,
} from "@/lib/tasks/workflow-handler-params"
import { getRegisteredHandlerSlugs } from "@/lib/tasks/workflow-registry"

describe("workflow handler-params registry — coverage", () => {
  it("registers a param schema for every registered handler", () => {
    const handlerSlugs = new Set(getRegisteredHandlerSlugs())
    const paramSchemaSlugs = new Set(getRegisteredHandlerParamSchemaSlugs())
    const missing = [...handlerSlugs].filter((s) => !paramSchemaSlugs.has(s))
    expect(missing).toEqual([])
  })

  it("does not register schemas for handlers that don't exist", () => {
    const handlerSlugs = new Set(getRegisteredHandlerSlugs())
    const orphans = getRegisteredHandlerParamSchemaSlugs().filter((s) => !handlerSlugs.has(s))
    expect(orphans).toEqual([])
  })
})

describe("chain.advance_sd_stage — target_stage required", () => {
  const schema = getHandlerParamSchema("chain.advance_sd_stage")!
  it("accepts a real catalog row shape", () => {
    expect(schema.safeParse({ target_stage: "Bank Visit" }).success).toBe(true)
  })
  it("rejects empty params", () => {
    expect(schema.safeParse({}).success).toBe(false)
  })
  it("rejects non-string target_stage", () => {
    expect(schema.safeParse({ target_stage: 42 }).success).toBe(false)
  })
})

describe("chain.update_contact_field — field required, value optional", () => {
  const schema = getHandlerParamSchema("chain.update_contact_field")!
  it("accepts the demo_review row shape (field + static value)", () => {
    expect(schema.safeParse({ field: "language", value: "it" }).success).toBe(true)
  })
  it("accepts just the field (operator supplies value at runtime)", () => {
    expect(schema.safeParse({ field: "language" }).success).toBe(true)
  })
  it("accepts numeric, boolean, null values", () => {
    expect(schema.safeParse({ field: "weight_kg", value: 42 }).success).toBe(true)
    expect(schema.safeParse({ field: "verified", value: true }).success).toBe(true)
    expect(schema.safeParse({ field: "deleted_at", value: null }).success).toBe(true)
  })
  it("rejects when field is missing", () => {
    expect(schema.safeParse({ value: "it" }).success).toBe(false)
  })
  it("rejects when field is empty string", () => {
    expect(schema.safeParse({ field: "", value: "it" }).success).toBe(false)
  })
  it("rejects object values (not a contact column shape)", () => {
    expect(schema.safeParse({ field: "x", value: { nested: 1 } }).success).toBe(false)
  })
})

describe("chain.update_account_field — same shape as contact-field", () => {
  const schema = getHandlerParamSchema("chain.update_account_field")!
  it("accepts field + scalar value", () => {
    expect(schema.safeParse({ field: "ein_number", value: "12-3456789" }).success).toBe(true)
  })
  it("rejects when field is missing", () => {
    expect(schema.safeParse({}).success).toBe(false)
  })
})

describe("chain.spawn_next_workflow — all fields optional", () => {
  const schema = getHandlerParamSchema("chain.spawn_next_workflow")!
  it("accepts empty (catalog-resolved transition path)", () => {
    expect(schema.safeParse({}).success).toBe(true)
  })
  it("accepts workflow_slug only", () => {
    expect(schema.safeParse({ workflow_slug: "itin_review" }).success).toBe(true)
  })
  it("accepts the full triple", () => {
    expect(
      schema.safeParse({
        workflow_slug: "itin_review",
        task_meta: { client_first_name: "Mario" },
        assigned_to: "Luca",
      }).success,
    ).toBe(true)
  })
  it("rejects empty workflow_slug", () => {
    expect(schema.safeParse({ workflow_slug: "" }).success).toBe(false)
  })
})

describe("sd.mark_complete — formation_progress real shape", () => {
  const schema = getHandlerParamSchema("sd.mark_complete")!
  it("accepts the formation_progress row shape", () => {
    expect(
      schema.safeParse({
        spawn_next_sds: ["State RA Renewal", "State Annual Report"],
        send_review_request: true,
      }).success,
    ).toBe(true)
  })
  it("accepts empty (no spawn, no review)", () => {
    expect(schema.safeParse({}).success).toBe(true)
  })
  it("rejects non-string array entries in spawn_next_sds", () => {
    expect(schema.safeParse({ spawn_next_sds: ["x", 42] }).success).toBe(false)
  })
})

describe("banking.approve_form — followup_task required + interior strict", () => {
  const schema = getHandlerParamSchema("banking.approve_form")!
  const valid = {
    followup_task: {
      title_template: "Schedule session — {company_name}",
      description_template: "Banking form for {company_name} reviewed.",
      assignee: "Luca",
      priority: "High" as const,
      category: "Banking",
    },
  }
  it("accepts the real banking_review_payset shape", () => {
    expect(schema.safeParse(valid).success).toBe(true)
  })
  it("rejects when followup_task is missing", () => {
    expect(schema.safeParse({}).success).toBe(false)
  })
  it("rejects unknown priority", () => {
    const bad = { followup_task: { ...valid.followup_task, priority: "Critical" } }
    expect(schema.safeParse(bad).success).toBe(false)
  })
  it("rejects empty template strings", () => {
    const bad = { followup_task: { ...valid.followup_task, title_template: "" } }
    expect(schema.safeParse(bad).success).toBe(false)
  })
})

describe("empty-schema handlers — strict, reject any extra keys", () => {
  const emptyHandlerSlugs = [
    "task.cancel",
    "task.flag_blocked",
    "task.reassign",
    "task.snooze",
    "task.waiting_with_optional_message",
    "chain.await_client_action",
    "chain.send_client_message",
    "chain.send_email",
    "chain.send_for_signature",
    "chain.upload_document",
    "closure.approve_data",
    "formation.confirm_ein_received",
    "itin.approve_and_send",
    "itin.confirm_number_received",
    "itin.recall_and_recorrect",
    "tax.approve_and_apply",
  ]
  it.each(emptyHandlerSlugs)("%s accepts {} and rejects {foo:'x'}", (slug) => {
    const schema = getHandlerParamSchema(slug)!
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ foo: "x" }).success).toBe(false)
  })
})
