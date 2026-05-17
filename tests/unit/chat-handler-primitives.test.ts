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

  it("as of Slice 7, open_modal and api_call are implemented", () => {
    expect([...IMPLEMENTED_PRIMITIVES].sort()).toEqual(["api_call", "open_modal"])
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

describe("validatePrimitiveHandler — api_call (implemented Slice 7)", () => {
  it("accepts a minimal api_call handler", () => {
    const h = { kind: "api_call", method: "POST", url_template: "/api/x" }
    expect(validatePrimitiveHandler(h)).toEqual(h)
  })

  it("accepts api_call with body_template", () => {
    const h = {
      kind: "api_call",
      method: "POST",
      url_template: "/api/x",
      body_template: { topic_name: "T", account_id: "{account_id}" },
    }
    expect(validatePrimitiveHandler(h)).toEqual(h)
  })

  it("rejects api_call with invalid method", () => {
    expect(
      validatePrimitiveHandler({ kind: "api_call", method: "TRACE", url_template: "/x" }),
    ).toBeNull()
  })

  it("rejects api_call with empty url_template", () => {
    expect(
      validatePrimitiveHandler({ kind: "api_call", method: "POST", url_template: "" }),
    ).toBeNull()
  })

  it("rejects api_call with non-object body_template", () => {
    expect(
      validatePrimitiveHandler({
        kind: "api_call",
        method: "POST",
        url_template: "/x",
        body_template: "nope",
      }),
    ).toBeNull()
  })
})

describe("validatePrimitiveHandler — still-staged gating", () => {
  it("rejects navigate until its first consumer ships", () => {
    expect(validatePrimitiveHandler({ kind: "navigate", url_template: "/x" })).toBeNull()
  })

  it("rejects client_action until its first consumer ships", () => {
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
