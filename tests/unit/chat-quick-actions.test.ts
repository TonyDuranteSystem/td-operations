/**
 * Pure-logic tests for lib/chat/quick-actions.ts
 *
 * Covers:
 *   - isAllowed: RBAC permissive default + role gating
 *   - satisfiesContext: requires_all (AND), requires_any (OR), both, neither
 *   - groupForRender: filter chain + grouping by surface + deterministic sort
 *   - validateMetadata: required keys, optional keys, malformed inputs
 *
 * Loader (listQuickActions) is covered by sandbox integration verification
 * since it depends on supabaseAdmin and real DB state.
 */

import { describe, expect, it } from "vitest"
import {
  filterForSurfaceAndContext,
  groupForRender,
  isAllowed,
  satisfiesContext,
  validateMetadata,
  type QuickAction,
} from "@/lib/chat/quick-actions"

function makeAction(slug: string, overrides: Partial<QuickAction["metadata"]> = {}): QuickAction {
  return {
    slug,
    display_name: slug,
    display_name_translations: {},
    description: null,
    metadata: {
      surface: "portal_chat_message",
      order: 10,
      icon: "ClipboardList",
      handler: {
        kind: "open_modal",
        modal_id: "quick_create",
        modal_params: { create_type: "task" },
      },
      ...overrides,
    },
  }
}

describe("isAllowed", () => {
  it("defaults to allowing both roles when permission is missing", () => {
    const a = makeAction("create_task")
    expect(isAllowed(a, "admin")).toBe(true)
    expect(isAllowed(a, "team")).toBe(true)
  })

  it("defaults to allowing both roles when role_in is an empty list", () => {
    const a = makeAction("create_task", { permission: { role_in: [] } })
    expect(isAllowed(a, "admin")).toBe(true)
    expect(isAllowed(a, "team")).toBe(true)
  })

  it("admin-only row hides for team", () => {
    const a = makeAction("admin_only", { permission: { role_in: ["admin"] } })
    expect(isAllowed(a, "admin")).toBe(true)
    expect(isAllowed(a, "team")).toBe(false)
  })

  it("team-only row hides for admin", () => {
    const a = makeAction("team_only", { permission: { role_in: ["team"] } })
    expect(isAllowed(a, "admin")).toBe(false)
    expect(isAllowed(a, "team")).toBe(true)
  })
})

describe("satisfiesContext", () => {
  it("always-visible item (no requirements) passes any context", () => {
    const a = makeAction("ping")
    expect(satisfiesContext(a, {})).toBe(true)
    expect(satisfiesContext(a, { account_id: "a" })).toBe(true)
  })

  it("requires_all enforces AND — all tokens must be present", () => {
    const a = makeAction("act", { requires_all: ["account_id", "deal_id"] })
    expect(satisfiesContext(a, {})).toBe(false)
    expect(satisfiesContext(a, { account_id: "a" })).toBe(false)
    expect(satisfiesContext(a, { deal_id: "d" })).toBe(false)
    expect(satisfiesContext(a, { account_id: "a", deal_id: "d" })).toBe(true)
  })

  it("requires_any enforces OR — at least one token must be present", () => {
    const a = makeAction("act", { requires_any: ["account_id", "contact_id"] })
    expect(satisfiesContext(a, {})).toBe(false)
    expect(satisfiesContext(a, { account_id: "a" })).toBe(true)
    expect(satisfiesContext(a, { contact_id: "c" })).toBe(true)
    expect(satisfiesContext(a, { account_id: "a", contact_id: "c" })).toBe(true)
  })

  it("requires_all + requires_any combined", () => {
    const a = makeAction("act", {
      requires_all: ["account_id"],
      requires_any: ["deal_id", "service_id"],
    })
    // missing both groups
    expect(satisfiesContext(a, {})).toBe(false)
    // only AND group satisfied
    expect(satisfiesContext(a, { account_id: "a" })).toBe(false)
    // only OR group satisfied
    expect(satisfiesContext(a, { deal_id: "d" })).toBe(false)
    // both satisfied
    expect(satisfiesContext(a, { account_id: "a", deal_id: "d" })).toBe(true)
    expect(satisfiesContext(a, { account_id: "a", service_id: "s" })).toBe(true)
  })

  it("treats null, undefined, and empty string as absent", () => {
    const a = makeAction("act", { requires_all: ["account_id"] })
    expect(satisfiesContext(a, { account_id: null })).toBe(false)
    expect(satisfiesContext(a, { account_id: undefined })).toBe(false)
    expect(satisfiesContext(a, { account_id: "" })).toBe(false)
    expect(satisfiesContext(a, { account_id: "uuid-123" })).toBe(true)
  })

  it("supports free-form context tokens (forward compatibility)", () => {
    // Imagine a future row referencing a token that doesn't exist today.
    // The catalog can ship the row; the page just needs to start providing
    // the token in its context object — no code change to satisfiesContext.
    const a = makeAction("act", { requires_all: ["referrer_contact_id"] })
    expect(satisfiesContext(a, { account_id: "a" })).toBe(false)
    expect(satisfiesContext(a, { referrer_contact_id: "rc-1" })).toBe(true)
  })
})

describe("groupForRender", () => {
  const seedActions: QuickAction[] = [
    makeAction("create_task", {
      surface: "portal_chat_message",
      order: 10,
      requires_all: ["account_id"],
    }),
    makeAction("create_sd", {
      surface: "portal_chat_message",
      order: 20,
      requires_all: ["account_id"],
      handler: {
        kind: "open_modal",
        modal_id: "quick_create",
        modal_params: { create_type: "sd" },
      },
    }),
    makeAction("create_invoice", {
      surface: "portal_chat_message",
      order: 30,
      requires_all: ["account_id"],
      handler: {
        kind: "open_modal",
        modal_id: "quick_create",
        modal_params: { create_type: "invoice" },
      },
    }),
    makeAction("future_thread_action", {
      surface: "internal_thread_header",
      order: 10,
      handler: {
        kind: "open_modal",
        modal_id: "delete_thread_confirm",
      },
      requires_all: ["thread_id"],
    }),
  ]

  it("groups by surface", () => {
    const out = groupForRender(seedActions, "admin", {
      account_id: "a",
      thread_id: "t",
    })
    expect(Object.keys(out).sort()).toEqual([
      "internal_thread_header",
      "portal_chat_message",
    ])
    expect(out.portal_chat_message.map((a) => a.slug)).toEqual([
      "create_task",
      "create_sd",
      "create_invoice",
    ])
    expect(out.internal_thread_header.map((a) => a.slug)).toEqual([
      "future_thread_action",
    ])
  })

  it("hides items whose context is missing", () => {
    // contact-only thread: no account_id → all three create_* items hidden
    const out = groupForRender(seedActions, "admin", { contact_id: "c" })
    expect(out.portal_chat_message ?? []).toEqual([])
    expect(out.internal_thread_header ?? []).toEqual([])
  })

  it("hides items the role isn't allowed to see", () => {
    const adminOnly = [
      makeAction("danger", {
        surface: "portal_chat_message",
        order: 10,
        permission: { role_in: ["admin"] },
      }),
    ]
    const teamOut = groupForRender(adminOnly, "team", { account_id: "a" })
    expect(teamOut.portal_chat_message ?? []).toEqual([])
    const adminOut = groupForRender(adminOnly, "admin", { account_id: "a" })
    expect(adminOut.portal_chat_message.map((a) => a.slug)).toEqual(["danger"])
  })

  it("sorts deterministically by order ASC then slug ASC for ties", () => {
    const ties = [
      makeAction("zeta", { surface: "s", order: 10 }),
      makeAction("alpha", { surface: "s", order: 10 }),
      makeAction("mid", { surface: "s", order: 10 }),
      makeAction("first", { surface: "s", order: 5 }),
    ]
    const out = groupForRender(ties, "admin", {})
    expect(out.s.map((a) => a.slug)).toEqual(["first", "alpha", "mid", "zeta"])
  })
})

describe("filterForSurfaceAndContext", () => {
  const actions: QuickAction[] = [
    makeAction("create_task", {
      surface: "portal_chat_message",
      order: 10,
      requires_all: ["account_id"],
    }),
    makeAction("create_sd", {
      surface: "portal_chat_message",
      order: 20,
      requires_all: ["account_id"],
      handler: {
        kind: "open_modal",
        modal_id: "quick_create",
        modal_params: { create_type: "sd" },
      },
    }),
    makeAction("create_invoice", {
      surface: "portal_chat_message",
      order: 30,
      requires_all: ["account_id"],
      handler: {
        kind: "open_modal",
        modal_id: "quick_create",
        modal_params: { create_type: "invoice" },
      },
    }),
    makeAction("future_thread_action", {
      surface: "internal_thread_header",
      order: 10,
      requires_all: ["thread_id"],
      handler: {
        kind: "open_modal",
        modal_id: "delete_thread_confirm",
      },
    }),
  ]

  it("returns only items for the requested surface", () => {
    const out = filterForSurfaceAndContext(actions, "portal_chat_message", {
      account_id: "a-1",
    })
    expect(out.map((a) => a.slug)).toEqual(["create_task", "create_sd", "create_invoice"])
  })

  it("returns empty when no items match the surface", () => {
    const out = filterForSurfaceAndContext(actions, "nonexistent_surface", {
      account_id: "a-1",
    })
    expect(out).toEqual([])
  })

  it("hides items whose context isn't satisfied (contact-only thread: no account_id)", () => {
    const out = filterForSurfaceAndContext(actions, "portal_chat_message", {
      contact_id: "c-1",
    })
    expect(out).toEqual([])
  })

  it("sorts deterministically by order ASC, slug ASC for ties", () => {
    const ties: QuickAction[] = [
      makeAction("zeta", { surface: "s", order: 10 }),
      makeAction("alpha", { surface: "s", order: 10 }),
      makeAction("first", { surface: "s", order: 5 }),
    ]
    const out = filterForSurfaceAndContext(ties, "s", {})
    expect(out.map((a) => a.slug)).toEqual(["first", "alpha", "zeta"])
  })
})

describe("validateMetadata", () => {
  const goodHandler = {
    kind: "open_modal",
    modal_id: "quick_create",
    modal_params: { create_type: "task" },
  }
  const good = {
    surface: "portal_chat_message",
    order: 10,
    icon: "ClipboardList",
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
      requires_all: ["account_id"],
      requires_any: [],
    }
    expect(validateMetadata(full)).not.toBeNull()
  })

  it("rejects null and primitives", () => {
    expect(validateMetadata(null)).toBeNull()
    expect(validateMetadata(undefined)).toBeNull()
    expect(validateMetadata("nope")).toBeNull()
    expect(validateMetadata(42)).toBeNull()
  })

  it("rejects missing required keys", () => {
    expect(validateMetadata({ ...good, surface: undefined })).toBeNull()
    expect(validateMetadata({ ...good, order: undefined })).toBeNull()
    expect(validateMetadata({ ...good, icon: undefined })).toBeNull()
    expect(validateMetadata({ ...good, handler: undefined })).toBeNull()
  })

  it("rejects wrong-type required keys", () => {
    expect(validateMetadata({ ...good, surface: 123 })).toBeNull()
    expect(validateMetadata({ ...good, order: "10" })).toBeNull()
    expect(validateMetadata({ ...good, icon: "" })).toBeNull()
    expect(validateMetadata({ ...good, handler: null })).toBeNull()
  })

  it("rejects malformed optional fields", () => {
    expect(validateMetadata({ ...good, requires_all: "account_id" })).toBeNull()
    expect(validateMetadata({ ...good, requires_any: [1, 2] })).toBeNull()
    expect(validateMetadata({ ...good, permission: { role_in: [1] } })).toBeNull()
  })

  it("rejects the legacy fixed-slug handler shape (string instead of object)", () => {
    expect(validateMetadata({ ...good, handler: "chat.quick_create" })).toBeNull()
  })

  it("rejects handler with unknown kind", () => {
    expect(validateMetadata({ ...good, handler: { kind: "ftp_upload", path: "/x" } })).toBeNull()
  })

  it("accepts api_call (Slice 7 added the primitive to IMPLEMENTED_PRIMITIVES)", () => {
    expect(
      validateMetadata({
        ...good,
        handler: { kind: "api_call", method: "POST", url_template: "/api/x" },
      }),
    ).not.toBeNull()
  })

  it("rejects still-staged primitives (navigate, client_action)", () => {
    expect(
      validateMetadata({ ...good, handler: { kind: "navigate", url_template: "/tasks" } }),
    ).toBeNull()
    expect(
      validateMetadata({
        ...good,
        handler: { kind: "client_action", action: "copy_to_clipboard" },
      }),
    ).toBeNull()
  })

  it("rejects open_modal with missing modal_id", () => {
    expect(
      validateMetadata({ ...good, handler: { kind: "open_modal", modal_params: {} } }),
    ).toBeNull()
  })

  it("rejects open_modal with non-object modal_params", () => {
    expect(
      validateMetadata({
        ...good,
        handler: { kind: "open_modal", modal_id: "x", modal_params: "nope" },
      }),
    ).toBeNull()
  })
})
