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

describe("workflow-registry — Slice 1 (empty)", () => {
  it("getRegisteredHandlerSlugs returns an array (empty at Slice 1)", () => {
    const slugs = getRegisteredHandlerSlugs()
    expect(Array.isArray(slugs)).toBe(true)
    // Slice 1 ships empty. When Slice 2 lands and registers handlers,
    // update this to reflect that — but the array shape contract is the
    // permanent invariant tested here.
    expect(slugs.filter((s) => !s.startsWith(TEST_PREFIX))).toEqual([])
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
