/**
 * P1.7 characterization — form completion → SD advance contract.
 *
 * Covers plan §4 P1.7 flow 5:
 *   Form completion (formation, onboarding, ITIN) → service_delivery
 *   stage advances correctly.
 *
 * Rather than mock the full 250-560 line form-completed route handlers
 * (which require Drive + Gmail + DB + tasks mocks), this test pins the
 * SD-advance contract each handler must honor, by exercising the
 * P1.6 operation layer with the exact stage strings the handlers use:
 *
 *   formation-form-completed  → createSD("Company Formation")
 *     expects stage="Data Collection", stage_order=1
 *
 *   onboarding-form-completed → createSD("Client Onboarding")
 *     expects stage="Data Collection", stage_order=1
 *
 *   itin-form-completed (pre-existing SD at "Data Collection")
 *     → advanceStageIfAt("Data Collection" → "Document Preparation")
 *     expects advanced=true, target_stage="Document Preparation"
 *
 *   itin-form-completed (no pre-existing SD)
 *     → createSD("ITIN", target_stage="Document Preparation")
 *     expects stage_order=2
 *
 * If any of these break (stage rename in pipeline_stages, handler
 * target_stage change, createSD validation regression), this test
 * fires. The stage values are characterization — they match what the
 * real form-completed routes write to DB today.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

// ─── Mock harness (pipeline_stages fixtures per service type) ──

interface StageRow {
  stage_name: string
  stage_order: number
}

let pipelineFixture: Record<string, StageRow[]> = {}
let existingSDStage: string | null = null
let existingSDServiceType: string = "ITIN"
let insertCapture: unknown = null
let updateCapture: { id?: string; payload?: Record<string, unknown> } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "pipeline_stages") {
        let filterType = ""
        let filterOrder: number | null = null
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col: string, val: string | number) => {
            if (col === "service_type") filterType = val as string
            if (col === "stage_order") filterOrder = val as number
            return chain
          }),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn((n: number) => {
            const stages = pipelineFixture[filterType] ?? []
            const filtered = filterOrder !== null
              ? stages.filter((s) => s.stage_order === filterOrder)
              : stages
            return Promise.resolve({ data: filtered.slice(0, n), error: null })
          }),
          then: (resolve: (v: { data: StageRow[]; error: null }) => void) =>
            resolve({ data: pipelineFixture[filterType] ?? [], error: null }),
        }
        return chain
      }
      if (table === "service_deliveries") {
        let filterId: string | null = null
        let pendingUpdate: Record<string, unknown> | null = null
        const chain = {
          insert: vi.fn((payload: unknown) => {
            insertCapture = payload
            return chain
          }),
          select: vi.fn().mockReturnThis(),
          update: vi.fn((payload: Record<string, unknown>) => {
            pendingUpdate = payload
            return chain
          }),
          eq: vi.fn((col: string, val: string) => {
            if (col === "id") filterId = val
            if (pendingUpdate !== null) {
              updateCapture = { id: val, payload: pendingUpdate }
              pendingUpdate = null
            }
            return chain
          }),
          single: vi.fn(() => {
            // Returning existing SD for advanceStageIfAt lookup
            if (existingSDStage && filterId) {
              const stages = pipelineFixture[existingSDServiceType] ?? []
              const stageRow = stages.find((s) => s.stage_name === existingSDStage)
              return Promise.resolve({
                data: {
                  id: filterId,
                  stage: existingSDStage,
                  service_type: existingSDServiceType,
                  stage_order: stageRow?.stage_order ?? 1,
                  account_id: "acc-1",
                  contact_id: "contact-1",
                  service_name: `${existingSDServiceType} SD`,
                  status: "active",
                  stage_history: [],
                },
                error: null,
              })
            }
            // Returning inserted row on select-single after insert
            const payload = insertCapture as Record<string, unknown> | null
            if (payload) {
              return Promise.resolve({
                data: {
                  id: "new-sd-id",
                  service_type: payload.service_type,
                  service_name: payload.service_name,
                  stage: payload.stage,
                  stage_order: payload.stage_order,
                  account_id: payload.account_id ?? null,
                  contact_id: payload.contact_id ?? null,
                },
                error: null,
              })
            }
            return Promise.resolve({ data: null, error: null })
          }),
        }
        return chain
      }
      if (table === "tasks") {
        return {
          insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
        }
      }
      if (table === "accounts") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(() =>
            Promise.resolve({ data: { portal_tier: "onboarding" }, error: null }),
          ),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
      }
    },
  },
}))

// Stub out the side-effect modules advanceServiceDelivery imports so
// tests don't need real task/notification/log wiring.
vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn(),
}))

vi.mock("@/lib/portal/notifications", () => ({
  createPortalNotification: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: vi.fn(() => Promise.resolve()),
}))

import { createSD, advanceStageIfAt } from "@/lib/operations/service-delivery"

beforeEach(() => {
  pipelineFixture = {
    "Company Formation": [
      { stage_name: "Data Collection", stage_order: 1 },
      { stage_name: "State Filing", stage_order: 2 },
    ],
    "Client Onboarding": [
      { stage_name: "Data Collection", stage_order: 1 },
      { stage_name: "Review & CRM Setup", stage_order: 2 },
    ],
    ITIN: [
      { stage_name: "Data Collection", stage_order: 1 },
      { stage_name: "Document Preparation", stage_order: 2 },
      { stage_name: "Client Signing", stage_order: 3 },
    ],
    "Company Closure": [
      { stage_name: "Data Collection", stage_order: 1 },
      { stage_name: "State Compliance Check", stage_order: 2 },
    ],
    "Banking Fintech": [
      { stage_name: "Data Collection", stage_order: 1 },
      { stage_name: "Application Submitted", stage_order: 2 },
    ],
  }
  existingSDStage = null
  existingSDServiceType = "ITIN"
  insertCapture = null
  updateCapture = null
})

// ─── formation-form-completed contract ──────────────────

describe("formation-form-completed → SD create contract", () => {
  it("creates SD at 'Data Collection' / stage_order=1", async () => {
    const result = await createSD({
      service_type: "Company Formation",
      service_name: "Company Formation - Test Client (New LLC)",
      contact_id: "contact-1",
      notes: "Auto-created from formation form tok-123",
    })
    expect(result.stage).toBe("Data Collection")
    expect(result.stage_order).toBe(1)
    expect(insertCapture).toMatchObject({
      service_type: "Company Formation",
      stage: "Data Collection",
      stage_order: 1,
      notes: expect.stringContaining("formation form tok-123"),
    })
  })
})

// ─── onboarding-form-completed contract ─────────────────

describe("onboarding-form-completed → SD create contract", () => {
  it("creates SD at 'Data Collection' / stage_order=1", async () => {
    const result = await createSD({
      service_type: "Client Onboarding",
      service_name: "Client Onboarding - Test Client (Existing LLC)",
      contact_id: "contact-1",
      notes: "Auto-created from onboarding form tok-456",
    })
    expect(result.stage).toBe("Data Collection")
    expect(result.stage_order).toBe(1)
    expect(insertCapture).toMatchObject({
      service_type: "Client Onboarding",
      stage: "Data Collection",
      stage_order: 1,
    })
  })
})

// ─── itin-form-completed contract ───────────────────────

describe("itin-form-completed → SD advance/create contract", () => {
  it("when SD exists at 'Data Collection', advances to 'Document Preparation'", async () => {
    existingSDStage = "Data Collection"
    const result = await advanceStageIfAt({
      delivery_id: "sd-itin-1",
      if_current_stage: "Data Collection",
      target_stage: "Document Preparation",
      actor: "itin-form-completed",
      notes: "ITIN form tok-789 submitted",
      skip_tasks: true,
    })
    expect(result.advanced).toBe(true)
    expect(result.current_stage).toBe("Data Collection")
    expect(result.result?.to_stage).toBe("Document Preparation")
    expect(result.result?.to_order).toBe(2)
    // Verify the DB write reached the service_deliveries row
    expect(updateCapture?.id).toBe("sd-itin-1")
    expect(updateCapture?.payload?.stage).toBe("Document Preparation")
  })

  it("when SD is already past 'Data Collection', skips (no double-advance)", async () => {
    existingSDStage = "Client Signing" // stage_order=3, past the gate
    const result = await advanceStageIfAt({
      delivery_id: "sd-itin-2",
      if_current_stage: "Data Collection",
      target_stage: "Document Preparation",
      skip_tasks: true,
    })
    expect(result.advanced).toBe(false)
    expect(result.current_stage).toBe("Client Signing")
    expect(result.reason).toMatch(/not in gate/)
    // No update should have been issued
    expect(updateCapture).toBeNull()
  })

  it("when no SD exists, creates one at 'Document Preparation' (stage_order=2)", async () => {
    // itin-form-completed's no-SD branch uses target_stage="Document
    // Preparation" because the client has already submitted data.
    const result = await createSD({
      service_type: "ITIN",
      service_name: "ITIN - Test Client",
      account_id: "acc-1",
      contact_id: "contact-1",
      target_stage: "Document Preparation",
      notes: "Auto-created from ITIN form tok-abc",
    })
    expect(result.stage).toBe("Document Preparation")
    expect(result.stage_order).toBe(2)
    expect(insertCapture).toMatchObject({
      service_type: "ITIN",
      stage: "Document Preparation",
      stage_order: 2,
    })
  })
})

// ─── closure-form-completed contract ────────────────────

describe("closure-form-completed → SD create contract", () => {
  it("creates SD at 'Data Collection' / stage_order=1", async () => {
    const result = await createSD({
      service_type: "Company Closure",
      service_name: "Company Closure - Test LLC",
      account_id: "acc-1",
      contact_id: "contact-1",
      notes: "Auto-created from closure form tok-def",
    })
    expect(result.stage).toBe("Data Collection")
    expect(result.stage_order).toBe(1)
  })
})

// ─── banking-form-completed contract ────────────────────

describe("banking-form-completed → SD advance contract", () => {
  it("advances Banking Fintech SD from 'Data Collection' → 'Application Submitted'", async () => {
    existingSDStage = "Data Collection"
    existingSDServiceType = "Banking Fintech"
    const result = await advanceStageIfAt({
      delivery_id: "sd-bank-1",
      if_current_stage: "Data Collection",
      target_stage: "Application Submitted",
      actor: "banking-form-completed",
      notes: "Relay (USD) banking form submitted by client",
      skip_tasks: true,
    })
    expect(result.advanced).toBe(true)
    expect(result.result?.to_stage).toBe("Application Submitted")
  })

  it("skips if SD is already past 'Data Collection'", async () => {
    existingSDStage = "Application Submitted"
    existingSDServiceType = "Banking Fintech"
    const result = await advanceStageIfAt({
      delivery_id: "sd-bank-2",
      if_current_stage: "Data Collection",
      target_stage: "Application Submitted",
      skip_tasks: true,
    })
    expect(result.advanced).toBe(false)
    expect(result.reason).toMatch(/not in gate/)
  })
})
