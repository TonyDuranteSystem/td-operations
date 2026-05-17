/**
 * Pure-logic tests for lib/chat/topic-templates.ts
 *
 * Mirror of chat-quick-actions tests — same shape, different surface and
 * primitive (api_call instead of open_modal).
 */

import { describe, expect, it } from "vitest"
import {
  filterForSurfaceAndContext,
  isAllowed,
  satisfiesContext,
  validateMetadata,
  type TopicTemplate,
} from "@/lib/chat/topic-templates"

function makeTemplate(slug: string, overrides: Partial<TopicTemplate["metadata"]> = {}): TopicTemplate {
  return {
    slug,
    display_name: slug,
    display_name_translations: {},
    description: null,
    metadata: {
      surface: "portal_chat_topic_create",
      order: 10,
      icon: "MessageCircle",
      requires_any: ["account_id", "contact_id"],
      handler: {
        kind: "api_call",
        method: "POST",
        url_template: "/api/portal/chat/topic/create",
        body_template: {
          topic_name: "Test",
          account_id: "{account_id}",
          contact_id: "{contact_id}",
          starter_message_en: "Hi",
        },
      },
      on_success: { toast: "Topic opened", set_active_topic: true, close_menu: true },
      ...overrides,
    },
  }
}

describe("isAllowed", () => {
  it("defaults to allowing both roles when permission missing", () => {
    const t = makeTemplate("itin")
    expect(isAllowed(t, "admin")).toBe(true)
    expect(isAllowed(t, "team")).toBe(true)
  })

  it("admin-only hides for team", () => {
    const t = makeTemplate("danger", { permission: { role_in: ["admin"] } })
    expect(isAllowed(t, "admin")).toBe(true)
    expect(isAllowed(t, "team")).toBe(false)
  })
})

describe("satisfiesContext", () => {
  it("requires_any: at least one of account_id or contact_id must be present", () => {
    const t = makeTemplate("itin")
    expect(satisfiesContext(t, {})).toBe(false)
    expect(satisfiesContext(t, { account_id: "a" })).toBe(true)
    expect(satisfiesContext(t, { contact_id: "c" })).toBe(true)
    expect(satisfiesContext(t, { account_id: "a", contact_id: "c" })).toBe(true)
  })

  it("treats null and empty string as absent (matches chat-quick-actions semantics)", () => {
    const t = makeTemplate("itin")
    expect(satisfiesContext(t, { account_id: null, contact_id: null })).toBe(false)
    expect(satisfiesContext(t, { account_id: "", contact_id: "" })).toBe(false)
  })
})

describe("filterForSurfaceAndContext", () => {
  const templates: TopicTemplate[] = [
    makeTemplate("itin", { order: 10 }),
    makeTemplate("banking", { order: 20 }),
    makeTemplate("general", { order: 99 }),
    makeTemplate("future_other_surface", { surface: "elsewhere", order: 5 }),
  ]

  it("returns only the requested surface, sorted by order", () => {
    const out = filterForSurfaceAndContext(templates, "portal_chat_topic_create", {
      account_id: "a-1",
    })
    expect(out.map((t) => t.slug)).toEqual(["itin", "banking", "general"])
  })

  it("hides items when no requires_any token is satisfied", () => {
    const out = filterForSurfaceAndContext(templates, "portal_chat_topic_create", {})
    expect(out).toEqual([])
  })

  it("returns empty for an unknown surface", () => {
    const out = filterForSurfaceAndContext(templates, "nope", { account_id: "a" })
    expect(out).toEqual([])
  })
})

describe("validateMetadata", () => {
  const goodHandler = {
    kind: "api_call",
    method: "POST",
    url_template: "/api/portal/chat/topic/create",
    body_template: { topic_name: "X" },
  }
  const good = {
    surface: "portal_chat_topic_create",
    order: 10,
    icon: "MessageCircle",
    handler: goodHandler,
  }

  it("accepts a minimal well-formed row", () => {
    expect(validateMetadata(good)).not.toBeNull()
  })

  it("accepts optional fields when shaped correctly", () => {
    const full = {
      ...good,
      color: "default",
      permission: { role_in: ["admin", "team"] },
      requires_any: ["account_id", "contact_id"],
      on_success: { toast: "X", set_active_topic: true, close_menu: true },
    }
    expect(validateMetadata(full)).not.toBeNull()
  })

  it("rejects null and primitives", () => {
    expect(validateMetadata(null)).toBeNull()
    expect(validateMetadata("nope")).toBeNull()
    expect(validateMetadata(42)).toBeNull()
  })

  it("rejects missing required keys", () => {
    expect(validateMetadata({ ...good, surface: undefined })).toBeNull()
    expect(validateMetadata({ ...good, icon: "" })).toBeNull()
    expect(validateMetadata({ ...good, handler: undefined })).toBeNull()
  })

  it("rejects malformed on_success", () => {
    expect(validateMetadata({ ...good, on_success: "nope" })).toBeNull()
  })

  it("rejects open_modal handler with missing modal_id (delegates to primitive validator)", () => {
    expect(
      validateMetadata({ ...good, handler: { kind: "open_modal", modal_id: "" } }),
    ).toBeNull()
  })

  it("accepts api_call (now implemented as of Slice 7)", () => {
    expect(
      validateMetadata({
        ...good,
        handler: { kind: "api_call", method: "POST", url_template: "/x" },
      }),
    ).not.toBeNull()
  })
})
