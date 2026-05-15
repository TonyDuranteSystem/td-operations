/**
 * Workflow handler registry — Slice 1.
 *
 * At Slice 1 the registry ships empty. Slice 2 adds the generic handlers.
 * This test pins behavior at the empty-registry state and verifies the
 * registration/lookup contract works once handlers exist.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _registerHandler,
  getRegisteredHandlerSlugs,
  getWorkflowHandler,
  requireWorkflowHandler,
} from "@/lib/tasks/workflow-registry"
import type { WorkflowHandler } from "@/lib/tasks/types"

const dummyHandler: WorkflowHandler = async () => ({
  success: true,
  side_effects: [],
})

// Track what we register so tests don't leak into each other.
const TEST_PREFIX = "_test."
function unregisterTestHandlers() {
  // The registry doesn't expose an unregister API by design — Slice 2's
  // handlers register once at module load. For tests we reach into the
  // closure via a side-door: the slugs map mutates so re-registering with
  // the same slug throws. We avoid that by using a unique slug per test.
}

// Slice 2: 14 generic handlers (5 task.* + 9 chain.* — 2 chain.* are
// NOT_IMPLEMENTED stubs but ARE registered).
// Slice 4: + 2 service-specific handlers (itin.approve_and_send,
// itin.recall_and_recorrect).
const REGISTERED_HANDLERS = [
  // Slice 2 — task lifecycle
  "task.flag_blocked",
  "task.waiting_with_optional_message",
  "task.snooze",
  "task.reassign",
  "task.cancel",
  // Slice 2 — chain primitives
  "chain.advance_sd_stage",
  "chain.spawn_next_workflow",
  "chain.send_client_message",
  "chain.send_email",
  "chain.send_for_signature",
  "chain.await_client_action",
  "chain.upload_document",
  "chain.update_contact_field",
  "chain.update_account_field",
  // Slice 4 — ITIN service-specific
  "itin.approve_and_send",
  "itin.recall_and_recorrect",
] as const

describe("workflow-registry — current handler set", () => {
  it("getRegisteredHandlerSlugs returns exactly the registered set (excluding test fixtures)", () => {
    const slugs = getRegisteredHandlerSlugs()
    expect(Array.isArray(slugs)).toBe(true)
    const real = slugs.filter((s) => !s.startsWith(TEST_PREFIX)).sort()
    expect(real).toEqual([...REGISTERED_HANDLERS].sort())
  })

  it("every registered handler is callable via getWorkflowHandler", () => {
    for (const slug of REGISTERED_HANDLERS) {
      const fn = getWorkflowHandler(slug)
      expect(fn, `Missing handler: ${slug}`).not.toBeNull()
      expect(typeof fn, `Not a function: ${slug}`).toBe("function")
    }
  })

  it("every registered handler resolves via requireWorkflowHandler", () => {
    for (const slug of REGISTERED_HANDLERS) {
      expect(() => requireWorkflowHandler(slug)).not.toThrow()
    }
  })

  it("getWorkflowHandler returns null for an unregistered slug", () => {
    expect(getWorkflowHandler("never.registered")).toBeNull()
  })

  it("requireWorkflowHandler throws with a clear message for a missing slug", () => {
    expect(() => requireWorkflowHandler("never.registered")).toThrowError(
      /'never\.registered' is not registered/,
    )
  })
})

describe("workflow-registry — registration contract", () => {
  // Each test uses a unique slug to avoid collisions across tests.
  let testSlug: string

  beforeEach(() => {
    testSlug = `${TEST_PREFIX}${Math.random().toString(36).slice(2, 10)}`
  })

  afterEach(() => {
    unregisterTestHandlers()
  })

  it("_registerHandler adds a handler that is then findable", () => {
    _registerHandler(testSlug, dummyHandler)
    expect(getWorkflowHandler(testSlug)).toBe(dummyHandler)
    expect(requireWorkflowHandler(testSlug)).toBe(dummyHandler)
    expect(getRegisteredHandlerSlugs()).toContain(testSlug)
  })

  it("_registerHandler throws on duplicate slug (catches accidental re-registration)", () => {
    _registerHandler(testSlug, dummyHandler)
    expect(() => _registerHandler(testSlug, dummyHandler)).toThrowError(
      /already registered/,
    )
  })
})
