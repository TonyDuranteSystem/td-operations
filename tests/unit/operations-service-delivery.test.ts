/**
 * P1.6 — lib/operations/service-delivery.ts unit tests
 *
 * Focus: stage resolution from pipeline_stages (the core correctness
 * guarantee of createSD). Exhaustive integration coverage of the full
 * advance-chain is intentionally deferred to P1.7 characterization tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

// ─── Mock harness ──────────────────────────────────────
//
// Each test provides its own pipeline_stages fixture by setting the
// module-scoped `pipelineFixture` before running the operation.

interface StageRow {
  stage_name: string
  stage_order: number
}

let pipelineFixture: Record<string, StageRow[]> = {}
let insertCapture: unknown = null
let insertResponse: { data: unknown; error: unknown } = {
  data: {
    id: "sd-uuid",
    service_type: "Test",
    service_name: "Test SD",
    stage: "placeholder",
    stage_order: 0,
    account_id: null,
    contact_id: null,
  },
  error: null,
}

function buildPipelineChain(service_type: string) {
  const stages = pipelineFixture[service_type] ?? []
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn((n: number) => {
      const subset = stages.slice(0, n)
      return Promise.resolve({ data: subset, error: null })
    }),
    then: (resolve: (v: { data: StageRow[]; error: null }) => void) =>
      resolve({ data: stages, error: null }),
  }
}

function buildSDChain() {
  const chain: {
    insert: ReturnType<typeof vi.fn>
    select: ReturnType<typeof vi.fn>
    single: ReturnType<typeof vi.fn>
  } = {
    insert: vi.fn((payload: unknown) => {
      insertCapture = payload
      return chain
    }),
    select: vi.fn().mockReturnThis(),
    single: vi.fn(() => Promise.resolve(insertResponse)),
  }
  return chain
}

vi.mock("@/lib/supabase-admin", () => {
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "pipeline_stages") {
          // Return a chainable object whose .eq("service_type", X) stores X
          // and whose .limit(N) resolves to the pipeline rows for X.
          let currentType = ""
          const chain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((_col: string, value: string) => {
              currentType = value
              return chain
            }),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn((n: number) => {
              const stages = pipelineFixture[currentType] ?? []
              return Promise.resolve({ data: stages.slice(0, n), error: null })
            }),
            then: (resolve: (v: { data: StageRow[]; error: null }) => void) => {
              const stages = pipelineFixture[currentType] ?? []
              return resolve({ data: stages, error: null })
            },
          }
          return chain
        }
        if (table === "service_deliveries") {
          return buildSDChain()
        }
        if (table === "accounts" || table === "contacts") {
          // createSD reads is_test from the linked account (or contact when
          // account_id is null) to propagate the test-record flag onto the SD.
          // Tests don't exercise this branch; return null so no propagation.
          const c = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
          }
          return c
        }
        // Unused tables get a no-op chain
        return buildPipelineChain("__unused__")
      },
    },
  }
})

// Import under test AFTER mocks
import { createSD } from "@/lib/operations/service-delivery"

beforeEach(() => {
  pipelineFixture = {}
  insertCapture = null
  insertResponse = {
    data: {
      id: "sd-uuid",
      service_type: "Test",
      service_name: "Test SD",
      stage: "placeholder",
      stage_order: 0,
      account_id: null,
      contact_id: null,
    },
    error: null,
  }
})

// ─── createSD ──────────────────────────────────────────

describe("createSD — stage resolution", () => {
  it("resolves the first stage (lowest stage_order) when target_stage is not provided", async () => {
    pipelineFixture = {
      "Company Formation": [
        { stage_name: "Data Collection", stage_order: 1 },
        { stage_name: "State Filing", stage_order: 2 },
      ],
    }
    insertResponse = {
      data: {
        id: "sd-1",
        service_type: "Company Formation",
        service_name: "Company Formation - Test LLC",
        stage: "Data Collection",
        stage_order: 1,
        account_id: "acc-1",
        contact_id: null,
      },
      error: null,
    }

    const result = await createSD({
      service_type: "Company Formation",
      service_name: "Company Formation - Test LLC",
      account_id: "acc-1",
    })

    expect(result.stage).toBe("Data Collection")
    expect(result.stage_order).toBe(1)
    expect(insertCapture).toMatchObject({
      service_type: "Company Formation",
      stage: "Data Collection",
      stage_order: 1,
    })
  })

  it("uses first stage from pipeline_stages even when it is not 'Data Collection' — CMRA case", async () => {
    // This is the core bug P1.6 closes: before, 5 admin routes hardcoded
    // stage='Data Collection' for CMRA — but CMRA's first stage is
    // actually 'Lease Created'.
    pipelineFixture = {
      "CMRA Mailing Address": [
        { stage_name: "Lease Created", stage_order: 1 },
        { stage_name: "Lease Signed", stage_order: 2 },
      ],
    }
    insertResponse = {
      data: {
        id: "sd-cmra",
        service_type: "CMRA Mailing Address",
        service_name: "CMRA",
        stage: "Lease Created",
        stage_order: 1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({ service_type: "CMRA Mailing Address" })

    expect(insertCapture).toMatchObject({
      stage: "Lease Created",
      stage_order: 1,
    })
  })

  it("uses Tax Return stage_order=-1 'Company Data Pending' when it is the lowest", async () => {
    pipelineFixture = {
      "Tax Return": [
        { stage_name: "Company Data Pending", stage_order: -1 },
        { stage_name: "Paid - Awaiting Data", stage_order: 0 },
        { stage_name: "1st Installment Paid", stage_order: 1 },
      ],
    }
    insertResponse = {
      data: {
        id: "sd-tr",
        service_type: "Tax Return",
        service_name: "TR",
        stage: "Company Data Pending",
        stage_order: -1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({ service_type: "Tax Return" })

    expect(insertCapture).toMatchObject({
      stage: "Company Data Pending",
      stage_order: -1,
    })
  })

  it("resolves named target_stage case-insensitively", async () => {
    pipelineFixture = {
      ITIN: [
        { stage_name: "Data Collection", stage_order: 1 },
        { stage_name: "Document Preparation", stage_order: 2 },
      ],
    }
    insertResponse = {
      data: {
        id: "sd-itin",
        service_type: "ITIN",
        service_name: "ITIN",
        stage: "Document Preparation",
        stage_order: 2,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({
      service_type: "ITIN",
      target_stage: "document preparation", // lower-case input
    })

    expect(insertCapture).toMatchObject({
      stage: "Document Preparation", // canonicalized from pipeline_stages
      stage_order: 2,
    })
  })

  it("throws on unknown service_type (no pipeline_stages rows)", async () => {
    pipelineFixture = {}
    await expect(createSD({ service_type: "UnknownService" })).rejects.toThrow(
      /No pipeline_stages defined for service_type="UnknownService"/,
    )
  })

  it("throws when target_stage is not a valid stage_name", async () => {
    pipelineFixture = {
      ITIN: [
        { stage_name: "Data Collection", stage_order: 1 },
        { stage_name: "Document Preparation", stage_order: 2 },
      ],
    }
    await expect(
      createSD({ service_type: "ITIN", target_stage: "Nonexistent Stage" }),
    ).rejects.toThrow(/Stage "Nonexistent Stage" not valid for service_type="ITIN"/)
  })

  it("honors target_stage_order override for Tax Return 'Company Data Pending'", async () => {
    // Contextual entry point: business Tax Return starts at stage_order=-1.
    // The caller passes both target_stage and target_stage_order explicitly
    // so createSD skips strict name validation.
    pipelineFixture = {
      "Tax Return": [
        { stage_name: "Company Data Pending", stage_order: -1 },
        { stage_name: "1st Installment Paid", stage_order: 1 },
      ],
    }
    insertResponse = {
      data: {
        id: "sd-biz-tr",
        service_type: "Tax Return",
        service_name: "Biz TR",
        stage: "Company Data Pending",
        stage_order: -1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({
      service_type: "Tax Return",
      target_stage: "Company Data Pending",
      target_stage_order: -1,
    })

    expect(insertCapture).toMatchObject({
      stage: "Company Data Pending",
      stage_order: -1,
    })
  })

  it("defaults service_name to service_type when omitted", async () => {
    pipelineFixture = {
      EIN: [{ stage_name: "SS-4 Preparation", stage_order: 1 }],
    }
    insertResponse = {
      data: {
        id: "sd-ein",
        service_type: "EIN",
        service_name: "EIN",
        stage: "SS-4 Preparation",
        stage_order: 1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({ service_type: "EIN" })

    expect(insertCapture).toMatchObject({
      service_name: "EIN",
    })
  })

  it("sets assigned_to='Luca' by default", async () => {
    pipelineFixture = {
      EIN: [{ stage_name: "SS-4 Preparation", stage_order: 1 }],
    }
    insertResponse = {
      data: {
        id: "sd-ein",
        service_type: "EIN",
        service_name: "EIN",
        stage: "SS-4 Preparation",
        stage_order: 1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({ service_type: "EIN" })

    expect(insertCapture).toMatchObject({ assigned_to: "Luca" })
  })

  it("sets status='active' by default", async () => {
    pipelineFixture = {
      EIN: [{ stage_name: "SS-4 Preparation", stage_order: 1 }],
    }
    insertResponse = {
      data: {
        id: "sd-ein",
        service_type: "EIN",
        service_name: "EIN",
        stage: "SS-4 Preparation",
        stage_order: 1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({ service_type: "EIN" })

    expect(insertCapture).toMatchObject({ status: "active" })
  })
})
