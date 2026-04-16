/**
 * P1.7 characterization — wizard-type chain integrity (flow 7 / ITIN
 * end-to-end coverage at the wiring layer).
 *
 * The full ITIN end-to-end (submission → itin_submissions → job →
 * handler → SD advance → PDFs → task → email) crosses too many IO
 * boundaries to run in a pre-push test. But the chain has a fragile
 * shape that the Phase 0 P0.5 rescue surfaced:
 *
 *   wizard_type → SUBMISSION_TABLES table name → writes a row
 *   wizard_type → JOB_TYPES job_type → registry.ts handlers → runs the
 *                                      background auto-chain
 *
 * If any link is missing (the P0.5 bug: itin was absent from
 * SUBMISSION_TABLES / JOB_TYPES, even though Damiano's and Antonio
 * Truocchio's wizard_progress rows existed), the chain silently
 * stops. This integration test asserts every link is wired up for
 * every type that has a background handler.
 *
 * Would have caught the P0.5 bug at build time instead of after two
 * client rescues.
 */

import { describe, it, expect } from "vitest"
import {
  VALID_WIZARD_TYPES,
  JOB_TYPES,
  getJobType,
  getSubmissionTable,
  isBankingInlineType,
  isUIOnlyType,
} from "@/lib/portal/wizard-map"
import { getJobHandler, getRegisteredJobTypes } from "@/lib/jobs/registry"

describe("wizard-chain integrity — wizard_type → job_type → registry handler", () => {
  it("every wizard_type with a job_type has a handler registered in lib/jobs/registry.ts", () => {
    const missingHandlers: Array<{ wizardType: string; jobType: string }> = []
    for (const wizardType of VALID_WIZARD_TYPES) {
      const jobType = getJobType(wizardType)
      if (jobType === null) continue
      if (getJobHandler(jobType) === null) {
        missingHandlers.push({ wizardType, jobType })
      }
    }
    expect(
      missingHandlers,
      `Wizard types mapped to job_types with no registry handler: ${JSON.stringify(missingHandlers)}`,
    ).toEqual([])
  })

  it("every covered wizard type either has a job handler, is banking-inline, is UI-only, or is a documented manual-workflow type", () => {
    // Single-line invariant: a submission exists only if SOMETHING
    // processes it. Banking-inline runs the handler inside the route.
    // UI-only types never submit. Manual-workflow types (closure) are
    // explicitly listed — delete the entry when they get a handler.
    const KNOWN_MANUAL_TYPES = new Set(["closure"])
    const orphaned: string[] = []
    for (const wizardType of VALID_WIZARD_TYPES) {
      if (isBankingInlineType(wizardType)) continue
      if (isUIOnlyType(wizardType)) continue
      if (KNOWN_MANUAL_TYPES.has(wizardType)) continue
      const jobType = getJobType(wizardType)
      if (!jobType || !getJobHandler(jobType)) {
        orphaned.push(wizardType)
      }
    }
    expect(
      orphaned,
      `Wizard types with no execution path: ${orphaned.join(", ")}`,
    ).toEqual([])
  })

  it("ITIN wizard chain is fully wired (submission table, job type, handler)", () => {
    // Explicit regression guard for the P0.5 bug class. If any of
    // these three assertions would have been an `undefined` before
    // 2026-04-14, Damiano and Antonio Truocchio's submissions would
    // not have silently dropped.
    expect(getSubmissionTable("itin")).toBe("itin_submissions")
    expect(getJobType("itin")).toBe("itin_wizard_setup")
    expect(getJobHandler("itin_wizard_setup")).not.toBeNull()
  })
})

describe("wizard-chain integrity — no orphan handlers", () => {
  it("every job_type referenced in JOB_TYPES map is registered", () => {
    // Catches the inverse bug: a job_type added to the wizard-map but
    // never actually registered with a handler.
    const registered = new Set(getRegisteredJobTypes())
    const missing: string[] = []
    for (const jobType of Object.values(JOB_TYPES)) {
      if (!jobType) continue
      if (!registered.has(jobType)) missing.push(jobType)
    }
    expect(
      missing,
      `Job types in JOB_TYPES but not registered: ${missing.join(", ")}`,
    ).toEqual([])
  })
})
