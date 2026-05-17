/**
 * Pure-logic tests for lib/chat/handler-primitives.ts
 *
 * Verifies the discriminated-union validation + staged-implementation
 * gating. Adding a new primitive's implementation = move its kind from
 * "documented" to IMPLEMENTED_PRIMITIVES + add positive tests here.
 */

import { describe, expect, it } from "vitest"
import {
  IMPLEMENTED_PRIMITIVES,
  PRIMITIVE_KINDS,
  validatePrimitiveHandler,
} from "@/lib/chat/handler-primitives"

describe("primitive registry constants", () => {
  it("declares the 4 canonical primitive kinds", () => {
    expect([...PRIMITIVE_KINDS].sort()).toEqual([
      "api_call",
      "client_action",
      "navigate",
      "open_modal",
    ])
  })

  it("today only open_modal is implemented (staged-implementation policy)", () => {
    expect([...IMPLEMENTED_PRIMITIVES].sort()).toEqual(["open_modal"])
  })
})

describe("validatePrimitiveHandler — open_modal (implemented)", () => {
  it("accepts a minimal open_modal handler", () => {
    const out = validatePrimitiveHandler({ kind: "open_modal", modal_id: "quick_create" })
    expect(out).toEqual({ kind: "open_modal", modal_id: "quick_create" })
  })

  it("accepts open_modal with modal_params", () => {
    const h = {
      kind: "open_modal",
      modal_id: "quick_create",
      modal_params: { create_type: "task" },
    }
    expect(validatePrimitiveHandler(h)).toEqual(h)
  })

  it("rejects open_modal with empty modal_id", () => {
    expect(validatePrimitiveHandler({ kind: "open_modal", modal_id: "" })).toBeNull()
  })

  it("rejects open_modal with non-string modal_id", () => {
    expect(validatePrimitiveHandler({ kind: "open_modal", modal_id: 42 })).toBeNull()
  })

  it("rejects open_modal with non-object modal_params", () => {
    expect(
      validatePrimitiveHandler({ kind: "open_modal", modal_id: "x", modal_params: "nope" }),
    ).toBeNull()
    expect(
      validatePrimitiveHandler({ kind: "open_modal", modal_id: "x", modal_params: null }),
    ).toBeNull()
  })
})

describe("validatePrimitiveHandler — staged gating", () => {
  it("rejects api_call until a slice implements it", () => {
    const wellFormed = {
      kind: "api_call",
      method: "POST",
      url_template: "/api/x",
      body_template: { y: 1 },
    }
    // Shape would be valid IF api_call were implemented — but it's not yet.
    expect(validatePrimitiveHandler(wellFormed)).toBeNull()
  })

  it("rejects navigate until implemented", () => {
    expect(validatePrimitiveHandler({ kind: "navigate", url_template: "/x" })).toBeNull()
  })

  it("rejects client_action until implemented", () => {
    expect(
      validatePrimitiveHandler({ kind: "client_action", action: "copy_to_clipboard" }),
    ).toBeNull()
  })
})

describe("validatePrimitiveHandler — invalid inputs", () => {
  it("rejects null and primitives", () => {
    expect(validatePrimitiveHandler(null)).toBeNull()
    expect(validatePrimitiveHandler(undefined)).toBeNull()
    expect(validatePrimitiveHandler("open_modal")).toBeNull()
    expect(validatePrimitiveHandler(42)).toBeNull()
  })

  it("rejects missing kind", () => {
    expect(validatePrimitiveHandler({ modal_id: "x" })).toBeNull()
  })

  it("rejects unknown kind", () => {
    expect(validatePrimitiveHandler({ kind: "telepath", payload: "x" })).toBeNull()
  })

  it("rejects non-string kind", () => {
    expect(validatePrimitiveHandler({ kind: 123, modal_id: "x" })).toBeNull()
  })
})
