/**
 * Tests for the Zod → FieldSpec introspector. Covers every FieldSpec kind
 * + the optional/nullable/default unwrapping rules. The renderer (React)
 * is built on top of this and inherits these guarantees.
 *
 * Also exercises every one of the 22 registered handler param schemas to
 * confirm the introspector handles real production shapes — if a new
 * handler ships an unsupported Zod construct, this test catches it before
 * the editor renders an empty form for it.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { introspect, type FieldSpec } from "@/lib/forms/schema-introspection"
import {
  getHandlerParamSchema,
  getRegisteredHandlerParamSchemaSlugs,
} from "@/lib/tasks/workflow-handler-params"

describe("introspect — scalars", () => {
  it("strings", () => {
    const f = introspect(z.string(), { key: "title" })
    expect(f.kind).toBe("string")
    expect(f.required).toBe(true)
    expect(f.label).toBe("Title")
  })

  it("string with min/max length", () => {
    const f = introspect(z.string().min(3).max(50))
    if (f.kind !== "string") throw new Error("expected string")
    expect(f.minLength).toBe(3)
    expect(f.maxLength).toBe(50)
  })

  it("numbers + integer flag + min/max", () => {
    const f = introspect(z.number().int().min(0).max(100))
    if (f.kind !== "number") throw new Error("expected number")
    expect(f.integer).toBe(true)
    expect(f.min).toBe(0)
    expect(f.max).toBe(100)
  })

  it("booleans", () => {
    expect(introspect(z.boolean()).kind).toBe("boolean")
  })
})

describe("introspect — optional / nullable / default unwrapping", () => {
  it("string().optional() → required=false", () => {
    const f = introspect(z.string().optional())
    expect(f.kind).toBe("string")
    expect(f.required).toBe(false)
  })

  it("string().nullable() → required=false", () => {
    const f = introspect(z.string().nullable())
    expect(f.required).toBe(false)
  })

  it("string().default('x') → required=false, defaultValue='x'", () => {
    const f = introspect(z.string().default("x"))
    expect(f.required).toBe(false)
    expect(f.defaultValue).toBe("x")
  })

  it("chained .optional().default('x') → required=false, default captured", () => {
    const f = introspect(z.string().optional().default("x"))
    expect(f.required).toBe(false)
    expect(f.defaultValue).toBe("x")
  })

  it("inner constraints survive unwrapping", () => {
    const f = introspect(z.string().min(2).optional())
    if (f.kind !== "string") throw new Error()
    expect(f.minLength).toBe(2)
  })
})

describe("introspect — enums + literals", () => {
  it("enum exposes options", () => {
    const f = introspect(z.enum(["a", "b", "c"]))
    if (f.kind !== "enum") throw new Error("expected enum")
    expect(f.options).toEqual(["a", "b", "c"])
  })

  it("literal carries the value", () => {
    const f = introspect(z.literal("done"))
    if (f.kind !== "literal") throw new Error("expected literal")
    expect(f.value).toBe("done")
  })
})

describe("introspect — arrays", () => {
  it("array of strings", () => {
    const f = introspect(z.array(z.string()), { key: "spawn_next_sds" })
    expect(f.kind).toBe("array_of_strings")
    expect(f.label).toBe("Spawn Next Sds")
  })

  it("array of numbers → unsupported", () => {
    const f = introspect(z.array(z.number()))
    if (f.kind !== "unsupported") throw new Error()
    expect(f.reason).toMatch(/array of 'number'/)
  })
})

describe("introspect — objects (nested)", () => {
  it("recurses into shape", () => {
    const f = introspect(
      z.object({
        title: z.string(),
        count: z.number().optional(),
      }),
    )
    if (f.kind !== "object") throw new Error("expected object")
    expect(Object.keys(f.fields)).toEqual(["title", "count"])
    expect(f.fields.title.kind).toBe("string")
    expect(f.fields.title.required).toBe(true)
    expect(f.fields.count.kind).toBe("number")
    expect(f.fields.count.required).toBe(false)
  })

  it("detects .strict()", () => {
    const f = introspect(z.object({}).strict())
    if (f.kind !== "object") throw new Error()
    expect(f.strict).toBe(true)
  })

  it("non-strict object", () => {
    const f = introspect(z.object({ a: z.string() }))
    if (f.kind !== "object") throw new Error()
    expect(f.strict).toBe(false)
  })
})

describe("introspect — records", () => {
  it("record renders as kind=record (JSON textarea fallback)", () => {
    const f = introspect(z.record(z.string(), z.unknown()))
    expect(f.kind).toBe("record")
  })
})

describe("introspect — scalar unions (the chain.update_*_field value pattern)", () => {
  it("union of string|number|boolean|null", () => {
    const f = introspect(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    if (f.kind !== "scalar_union") throw new Error("expected scalar_union")
    expect(f.allowed.sort()).toEqual(["boolean", "null", "number", "string"])
  })

  it("union with object element → unsupported", () => {
    const f = introspect(z.union([z.string(), z.object({ a: z.string() })]))
    if (f.kind !== "unsupported") throw new Error()
    expect(f.reason).toMatch(/union/)
  })
})

describe("introspect — label derivation", () => {
  it("uses opts.label when provided", () => {
    expect(introspect(z.string(), { label: "Custom Label" }).label).toBe("Custom Label")
  })
  it("humanizes the key when label not provided", () => {
    expect(introspect(z.string(), { key: "task_title_template" }).label).toBe("Task Title Template")
  })
  it("falls back to 'Value' when neither", () => {
    expect(introspect(z.string()).label).toBe("Value")
  })
})

describe("introspect — covers every registered handler-params schema (no unsupported root)", () => {
  // Every registered handler's param schema must introspect into something
  // the renderer can handle (kind != 'unsupported' at the ROOT). Sub-fields
  // can fall back individually; what we forbid is a schema we can't even
  // start to render.
  it.each(getRegisteredHandlerParamSchemaSlugs())("%s root introspects to a supported kind", (slug) => {
    const schema = getHandlerParamSchema(slug)!
    const root = introspect(schema)
    expect(root.kind).not.toBe("unsupported")
  })
})

describe("introspect — concrete handler shapes render correctly", () => {
  it("banking.approve_form (nested object with enum)", () => {
    const root = introspect(getHandlerParamSchema("banking.approve_form")!)
    if (root.kind !== "object") throw new Error("banking.approve_form root must be object")
    const followup = root.fields.followup_task
    if (followup.kind !== "object") throw new Error("followup_task must be object")
    expect(followup.fields.priority.kind).toBe("enum")
    if (followup.fields.priority.kind === "enum") {
      expect(followup.fields.priority.options).toEqual(["Urgent", "High", "Normal", "Low"])
    }
  })

  it("sd.mark_complete (object with array_of_strings + optional boolean)", () => {
    const root = introspect(getHandlerParamSchema("sd.mark_complete")!)
    if (root.kind !== "object") throw new Error()
    const arr: FieldSpec = root.fields.spawn_next_sds
    expect(arr.kind).toBe("array_of_strings")
    expect(arr.required).toBe(false)
    const bool: FieldSpec = root.fields.send_review_request
    expect(bool.kind).toBe("boolean")
    expect(bool.required).toBe(false)
  })

  it("chain.update_contact_field (string + scalar_union)", () => {
    const root = introspect(getHandlerParamSchema("chain.update_contact_field")!)
    if (root.kind !== "object") throw new Error()
    expect(root.fields.field.kind).toBe("string")
    expect(root.fields.field.required).toBe(true)
    expect(root.fields.value.kind).toBe("scalar_union")
    expect(root.fields.value.required).toBe(false)
  })

  it("chain.spawn_next_workflow (all optional, one is a record)", () => {
    const root = introspect(getHandlerParamSchema("chain.spawn_next_workflow")!)
    if (root.kind !== "object") throw new Error()
    expect(root.fields.workflow_slug.kind).toBe("string")
    expect(root.fields.workflow_slug.required).toBe(false)
    expect(root.fields.task_meta.kind).toBe("record")
    expect(root.fields.assigned_to.kind).toBe("string")
  })

  it("empty-schema handlers introspect to object with zero fields, strict=true", () => {
    const root = introspect(getHandlerParamSchema("task.cancel")!)
    if (root.kind !== "object") throw new Error()
    expect(Object.keys(root.fields)).toEqual([])
    expect(root.strict).toBe(true)
  })
})
