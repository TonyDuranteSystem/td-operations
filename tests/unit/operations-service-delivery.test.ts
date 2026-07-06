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

// Catalog lookup is mocked so createSD's FK resolution is isolated from the
// catalog framework's DB layer (covered separately in catalog-framework.test).
const { catalogLookup } = vi.hoisted(() => ({
  catalogLookup: vi.fn<(serviceType: string) => Promise<{ id: string } | null>>(),
}))

vi.mock("@/lib/services", () => ({
  getEntryByServiceType: (serviceType: string) => catalogLookup(serviceType),
}))

// ─── Mock harness ──────────────────────────────────────
//
// Each test provides its own pipeline_stages fixture by setting the
// module-scoped `pipelineFixture` before running the operation.

interface StageRow {
  stage_name: string
  stage_order: number
}

interface AccountContactRow {
  contact_id: string
  is_primary: boolean
}

let pipelineFixture: Record<string, StageRow[]> = {}
// Per-account_id fixture for account_contacts. ITIN Phase B resolution
// (lib/operations/service-delivery.ts) queries this table when an admin
// creates an ITIN SD with only account_id — the lookup picks the primary
// contact (or earliest-linked) so callers don't have to know the rule.
let accountContactsFixture: Record<string, AccountContactRow[]> = {}
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
        if (table === "account_contacts") {
          // ITIN Phase B: createSD queries account_contacts when only
          // account_id is provided so it can auto-resolve the contact_id.
          // The chain is `.eq("account_id", X).order("is_primary", desc).order("contact_id", asc).limit(1)`.
          // account_contacts has no created_at column (verified in
          // information_schema 2026-05-11), so contact_id is the stable
          // tiebreaker.
          let currentAccountId = ""
          const chain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((_col: string, value: string) => {
              currentAccountId = value
              return chain
            }),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn((n: number) => {
              const rows = accountContactsFixture[currentAccountId] ?? []
              // Mirror the SQL: is_primary DESC, contact_id ASC, limit n.
              const sorted = [...rows].sort((a, b) => {
                if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1
                return a.contact_id.localeCompare(b.contact_id)
              })
              return Promise.resolve({ data: sorted.slice(0, n), error: null })
            }),
          }
          return chain
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
  accountContactsFixture = {}
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
  catalogLookup.mockReset()
  catalogLookup.mockResolvedValue(null)
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
        contact_id: "contact-1",
      },
      error: null,
    }

    await createSD({
      service_type: "ITIN",
      contact_id: "contact-1", // Phase 1 ITIN rule — contact_id required
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
      createSD({
        service_type: "ITIN",
        contact_id: "contact-1", // Phase 1 ITIN rule — contact_id required
        target_stage: "Nonexistent Stage",
      }),
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

// ─── createSD — Phase 1 ITIN architectural rule (2026-05-11) ─────────────

describe("createSD — ITIN contact-only enforcement", () => {
  const itinPipeline = {
    ITIN: [
      { stage_name: "Data Collection", stage_order: 1 },
      { stage_name: "Document Preparation", stage_order: 2 },
    ],
  }
  const itinInsertResponse = {
    data: {
      id: "sd-itin",
      service_type: "ITIN",
      service_name: "ITIN",
      stage: "Data Collection",
      stage_order: 1,
      account_id: null,
      contact_id: "contact-1",
    },
    error: null,
  }

  it("creates ITIN SD when contact_id is provided (account_id stays null)", async () => {
    pipelineFixture = itinPipeline
    insertResponse = itinInsertResponse

    await createSD({ service_type: "ITIN", contact_id: "contact-1" })

    expect(insertCapture).toMatchObject({
      service_type: "ITIN",
      contact_id: "contact-1",
      account_id: null,
    })
  })

  it("forces account_id to null when both account_id and contact_id are passed", async () => {
    pipelineFixture = itinPipeline
    insertResponse = itinInsertResponse

    await createSD({
      service_type: "ITIN",
      account_id: "acct-should-be-stripped",
      contact_id: "contact-1",
    })

    expect(insertCapture).toMatchObject({
      service_type: "ITIN",
      contact_id: "contact-1",
      account_id: null,
    })
  })

  it("throws when ITIN is created with neither account_id nor contact_id", async () => {
    pipelineFixture = itinPipeline
    // With no account_id, there's no way to resolve a contact — fail loudly.
    await expect(
      createSD({ service_type: "ITIN" }),
    ).rejects.toThrow(/service_type="ITIN" requires contact_id/)
  })

  it("Phase B: auto-resolves contact_id from account_contacts when ITIN is created with account_id only", async () => {
    // Phase B (ITIN Chain Fix 2026-05-11): admin creates an ITIN SD from
    // the CRM by passing only account_id — createSD looks up the primary
    // contact via account_contacts and uses it, setting account_id=null.
    pipelineFixture = itinPipeline
    accountContactsFixture = {
      "acct-with-contact": [
        { contact_id: "primary-contact", is_primary: true },
        { contact_id: "alpha-contact", is_primary: false },
      ],
    }
    insertResponse = {
      data: {
        id: "sd-itin",
        service_type: "ITIN",
        service_name: "ITIN",
        stage: "Data Collection",
        stage_order: 1,
        account_id: null,
        contact_id: "primary-contact",
      },
      error: null,
    }

    await createSD({ service_type: "ITIN", account_id: "acct-with-contact" })

    expect(insertCapture).toMatchObject({
      service_type: "ITIN",
      contact_id: "primary-contact",
      account_id: null,
    })
  })

  it("Phase B: falls back to alphabetically-first contact_id when no primary is set", async () => {
    // account_contacts has no created_at column — contact_id alphabetical
    // is the stable tiebreaker (verified in information_schema 2026-05-11).
    pipelineFixture = itinPipeline
    accountContactsFixture = {
      "acct-no-primary": [
        { contact_id: "zeta", is_primary: false },
        { contact_id: "alpha", is_primary: false },
      ],
    }
    insertResponse = {
      data: {
        id: "sd-itin",
        service_type: "ITIN",
        service_name: "ITIN",
        stage: "Data Collection",
        stage_order: 1,
        account_id: null,
        contact_id: "alpha",
      },
      error: null,
    }

    await createSD({ service_type: "ITIN", account_id: "acct-no-primary" })

    expect(insertCapture).toMatchObject({
      contact_id: "alpha",
      account_id: null,
    })
  })

  it("Phase B: throws a clear error when ITIN account has no linked contacts", async () => {
    pipelineFixture = itinPipeline
    accountContactsFixture = {} // No links for any account.
    await expect(
      createSD({ service_type: "ITIN", account_id: "acct-empty" }),
    ).rejects.toThrow(/has no linked contacts in account_contacts/)
  })

  it("does not affect non-ITIN service types (account_id preserved)", async () => {
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
        account_id: "acct-1",
        contact_id: null,
      },
      error: null,
    }

    await createSD({ service_type: "EIN", account_id: "acct-1" })

    expect(insertCapture).toMatchObject({
      service_type: "EIN",
      account_id: "acct-1",
    })
  })

  it("strips account_id for ITIN even when target_stage AND target_stage_order are both passed (sd_create refactor path, 2026-05-11)", async () => {
    // Regression for the sd_create MCP tool refactor (ITIN Chain Fix Phase A):
    // sd_create now passes BOTH target_stage and target_stage_order to createSD
    // (it pre-resolves firstStage and forwards both to skip name validation).
    // The ITIN architectural enforcement must run BEFORE the stage resolution
    // branch — confirm an account_id passed alongside ITIN still gets stripped.
    pipelineFixture = itinPipeline
    insertResponse = itinInsertResponse

    await createSD({
      service_type: "ITIN",
      account_id: "acct-should-be-stripped",
      contact_id: "contact-1",
      target_stage: "Data Collection",
      target_stage_order: 1,
    })

    expect(insertCapture).toMatchObject({
      service_type: "ITIN",
      contact_id: "contact-1",
      account_id: null,
      stage: "Data Collection",
      stage_order: 1,
    })
  })

  it("does not affect 'ITIN Renewal' (only 'ITIN' is enforced by Phase 1)", async () => {
    // Phase 1 spec only enforces the rule on service_type='ITIN'. ITIN
    // Renewal sits in a different operational lane and is out of scope.
    pipelineFixture = {
      "ITIN Renewal": [{ stage_name: "Data Collection", stage_order: 1 }],
    }
    insertResponse = {
      data: {
        id: "sd-itin-renew",
        service_type: "ITIN Renewal",
        service_name: "ITIN Renewal",
        stage: "Data Collection",
        stage_order: 1,
        account_id: "acct-1",
        contact_id: null,
      },
      error: null,
    }

    await createSD({ service_type: "ITIN Renewal", account_id: "acct-1" })

    expect(insertCapture).toMatchObject({
      service_type: "ITIN Renewal",
      account_id: "acct-1",
    })
  })
})

// ─── createSD — catalog FK resolution (Phase 4 Step 1) ────────────────────

describe("createSD — service_type_entry_id (catalog FK)", () => {
  it("sets service_type_entry_id when the catalog lookup matches", async () => {
    pipelineFixture = {
      EIN: [{ stage_name: "SS-4 Preparation", stage_order: 1 }],
    }
    catalogLookup.mockResolvedValueOnce({ id: "cat-ein-uuid" })
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

    expect(catalogLookup).toHaveBeenCalledWith("EIN")
    expect(insertCapture).toMatchObject({
      service_type: "EIN",
      service_type_entry_id: "cat-ein-uuid",
    })
  })

  it("inserts with service_type_entry_id=null and does NOT throw when no catalog entry matches", async () => {
    pipelineFixture = {
      Support: [{ stage_name: "Open", stage_order: 1 }],
    }
    catalogLookup.mockResolvedValueOnce(null)
    insertResponse = {
      data: {
        id: "sd-support",
        service_type: "Support",
        service_name: "Support",
        stage: "Open",
        stage_order: 1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(createSD({ service_type: "Support" })).resolves.toMatchObject({
      id: "sd-support",
    })

    expect(insertCapture).toMatchObject({
      service_type: "Support",
      service_type_entry_id: null,
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no catalog entry for service_type="Support"'),
    )

    warn.mockRestore()
  })

  it("Phase 4 Step 3 — passes amount + amount_currency through to insert when provided", async () => {
    pipelineFixture = {
      "Client Onboarding": [{ stage_name: "Data Collection", stage_order: 1 }],
    }
    insertResponse = {
      data: {
        id: "sd-onb",
        service_type: "Client Onboarding",
        service_name: "Client Onboarding - Acme",
        stage: "Data Collection",
        stage_order: 1,
        account_id: "acct-1",
        contact_id: null,
      },
      error: null,
    }

    await createSD({
      service_type: "Client Onboarding",
      service_name: "Client Onboarding - Acme",
      account_id: "acct-1",
      amount: 2300,
      amount_currency: "EUR",
    })

    expect(insertCapture).toMatchObject({
      amount: 2300,
      amount_currency: "EUR",
    })
  })

  it("Phase 4 Step 3 — defaults amount_currency to USD when amount is provided without currency", async () => {
    pipelineFixture = {
      "Client Onboarding": [{ stage_name: "Data Collection", stage_order: 1 }],
    }
    insertResponse = {
      data: {
        id: "sd-onb",
        service_type: "Client Onboarding",
        service_name: "Client Onboarding",
        stage: "Data Collection",
        stage_order: 1,
        account_id: null,
        contact_id: null,
      },
      error: null,
    }

    await createSD({
      service_type: "Client Onboarding",
      amount: 1500,
    })

    expect(insertCapture).toMatchObject({
      amount: 1500,
      amount_currency: "USD",
    })
  })

  it("Phase 4 Step 3 — omits amount fields entirely when amount is not provided", async () => {
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

    // Spread clause should NOT include amount keys when amount is undefined.
    expect(insertCapture).not.toHaveProperty("amount")
    expect(insertCapture).not.toHaveProperty("amount_currency")
  })

  it("treats a thrown catalog lookup as a soft failure (insert proceeds with null FK)", async () => {
    pipelineFixture = {
      EIN: [{ stage_name: "SS-4 Preparation", stage_order: 1 }],
    }
    catalogLookup.mockRejectedValueOnce(new Error("catalog DB down"))
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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(createSD({ service_type: "EIN" })).resolves.toMatchObject({
      id: "sd-ein",
    })

    expect(insertCapture).toMatchObject({
      service_type: "EIN",
      service_type_entry_id: null,
    })

    warn.mockRestore()
  })
})

// ─── createSD — non-ITIN person-link hygiene (2026-07-06) ──────────────────
//
// Prowave What's New incident follow-up: company SDs created with only an
// account_id auto-resolve contact_id from account_contacts (primary first,
// contact_id alphabetical tiebreak) while KEEPING account_id set, so the
// sd_created workflow note is dual-tagged and reaches the person thread.

describe("createSD — non-ITIN person-link hygiene", () => {
  const einPipeline = {
    EIN: [{ stage_name: "SS-4 Preparation", stage_order: 1 }],
  }
  const einInsertResponse = {
    data: {
      id: "sd-ein",
      service_type: "EIN",
      service_name: "EIN",
      stage: "SS-4 Preparation",
      stage_order: 1,
      account_id: "acct-1",
      contact_id: "primary-contact",
    },
    error: null,
  }

  it("auto-fills contact_id from account_contacts, KEEPING account_id", async () => {
    pipelineFixture = einPipeline
    insertResponse = einInsertResponse
    accountContactsFixture = {
      "acct-1": [
        { contact_id: "primary-contact", is_primary: true },
        { contact_id: "alpha-contact", is_primary: false },
      ],
    }

    await createSD({ service_type: "EIN", account_id: "acct-1" })

    expect(insertCapture).toMatchObject({
      service_type: "EIN",
      account_id: "acct-1",
      contact_id: "primary-contact",
    })
  })

  it("respects an explicitly passed contact_id (no lookup override)", async () => {
    pipelineFixture = einPipeline
    insertResponse = einInsertResponse
    accountContactsFixture = {
      "acct-1": [{ contact_id: "primary-contact", is_primary: true }],
    }

    await createSD({
      service_type: "EIN",
      account_id: "acct-1",
      contact_id: "explicit-contact",
    })

    expect(insertCapture).toMatchObject({
      account_id: "acct-1",
      contact_id: "explicit-contact",
    })
  })

  it("leaves contact_id null when the account has no linked contacts — never throws", async () => {
    pipelineFixture = einPipeline
    insertResponse = einInsertResponse
    accountContactsFixture = {} // no links

    await expect(
      createSD({ service_type: "EIN", account_id: "acct-lonely" }),
    ).resolves.toBeTruthy()

    expect(insertCapture).toMatchObject({
      account_id: "acct-lonely",
      contact_id: null,
    })
  })

  it("uses alphabetical tiebreak when no primary contact is flagged", async () => {
    pipelineFixture = einPipeline
    insertResponse = einInsertResponse
    accountContactsFixture = {
      "acct-1": [
        { contact_id: "zeta", is_primary: false },
        { contact_id: "alpha", is_primary: false },
      ],
    }

    await createSD({ service_type: "EIN", account_id: "acct-1" })

    expect(insertCapture).toMatchObject({ contact_id: "alpha" })
  })

  it("contact-only non-ITIN SD (no account_id) is untouched — no lookup possible", async () => {
    pipelineFixture = einPipeline
    insertResponse = einInsertResponse

    await createSD({ service_type: "EIN", contact_id: "solo-contact" })

    expect(insertCapture).toMatchObject({
      account_id: null,
      contact_id: "solo-contact",
    })
  })
})
