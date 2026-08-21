/**
 * Automatic lease/OA creation switch (2026-08-19) — the single reversible OFF
 * gate that stops the onboarding and welcome-package jobs from auto-creating
 * a client's lease and Operating Agreement.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { autoDocumentCreationEnabled } from "@/lib/jobs/auto-document-creation-switch"

const ORIGINAL = process.env.AUTO_LEASE_OA_CREATION_ENABLED

describe("autoDocumentCreationEnabled", () => {
  beforeEach(() => {
    delete process.env.AUTO_LEASE_OA_CREATION_ENABLED
  })
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AUTO_LEASE_OA_CREATION_ENABLED
    else process.env.AUTO_LEASE_OA_CREATION_ENABLED = ORIGINAL
  })

  it("defaults OFF when the env var is unset", () => {
    expect(autoDocumentCreationEnabled()).toBe(false)
  })

  it("is ON only for the exact string 'true'", () => {
    process.env.AUTO_LEASE_OA_CREATION_ENABLED = "true"
    expect(autoDocumentCreationEnabled()).toBe(true)
  })

  it("stays OFF for any other truthy-looking value", () => {
    for (const v of ["1", "TRUE", "yes", "on", ""]) {
      process.env.AUTO_LEASE_OA_CREATION_ENABLED = v
      expect(autoDocumentCreationEnabled()).toBe(false)
    }
  })
})
