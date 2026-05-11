/**
 * Unit tests for lib/operations/tax-return-sd-bridge.ts.
 *
 * Covers:
 *   - mapTaxReturnStatusToSDStage: all 11 real tax_return_status enum values,
 *     unknown values, and null/undefined input.
 *   - syncTaxReturnToSD: TR not found, no mapping, no account_id, SD not
 *     present (createSD path), SD already at target (noop), SD at different
 *     stage (advance path with actor="tax-return-tab"), createSD failure,
 *     advanceStage success=false, advanceStage throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface TRRow {
  id: string
  account_id: string | null
  contact_id: string | null
  status: string | null
  company_name: string | null
  tax_year: number | null
}

interface SDRow {
  id: string
  stage: string | null
  stage_order: number | null
  status: string
}

let trFixture: TRRow | null = null
let trError: { message: string } | null = null
let sdFixture: SDRow | null = null
let sdError: { message: string } | null = null

const createSDMock = vi.fn()
const advanceStageMock = vi.fn()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "tax_returns") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() =>
            Promise.resolve({ data: trFixture, error: trError }),
          ),
        }
      }
      if (table === "service_deliveries") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          neq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() =>
            Promise.resolve({ data: sdFixture, error: sdError }),
          ),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  },
}))

vi.mock("@/lib/operations/service-delivery", () => ({
  createSD: (...args: unknown[]) => createSDMock(...args),
  advanceStage: (...args: unknown[]) => advanceStageMock(...args),
}))

import {
  mapTaxReturnStatusToSDStage,
  syncTaxReturnToSD,
  TAX_RETURN_SD_ACTOR,
} from "@/lib/operations/tax-return-sd-bridge"

beforeEach(() => {
  trFixture = {
    id: "tr-1",
    account_id: "acct-1",
    contact_id: "contact-1",
    status: "Data Received",
    company_name: "Acme LLC",
    tax_year: 2024,
  }
  trError = null
  sdFixture = null
  sdError = null
  createSDMock.mockReset()
  advanceStageMock.mockReset()
})

describe("mapTaxReturnStatusToSDStage", () => {
  it.each([
    ["Payment Pending", "Company Data Pending", -1],
    ["Not Invoiced", "Company Data Pending", -1],
    ["Paid - Not Started", "Paid - Awaiting Data", 0],
    ["Activated - Need Link", "Paid - Awaiting Data", 0],
    ["Link Sent - Awaiting Data", "Paid - Awaiting Data", 0],
    ["Extension Requested", "Extension Filed", 2],
    ["Extension Filed", "Extension Filed", 2],
    ["Data Received", "Data Received", 3],
    ["Sent to India", "Preparation", 5],
    ["TR Completed - Awaiting Signature", "TR Completed", 6],
    ["TR Filed", "TR Filed", 7],
  ])("maps %s to %s (order %d)", (status, stageName, stageOrder) => {
    expect(mapTaxReturnStatusToSDStage(status)).toEqual({
      stage_name: stageName,
      stage_order: stageOrder,
    })
  })

  it("returns null for unknown status values", () => {
    expect(mapTaxReturnStatusToSDStage("Bogus Status")).toBeNull()
  })

  it("returns null for null and undefined", () => {
    expect(mapTaxReturnStatusToSDStage(null)).toBeNull()
    expect(mapTaxReturnStatusToSDStage(undefined)).toBeNull()
    expect(mapTaxReturnStatusToSDStage("")).toBeNull()
  })
})

describe("syncTaxReturnToSD", () => {
  it("returns skipped when tax_returns lookup fails", async () => {
    trFixture = null
    trError = { message: "boom" }
    const result = await syncTaxReturnToSD("tr-1")
    expect(result.action).toBe("skipped")
    expect(result.reason).toMatch(/tax_returns lookup failed/)
    expect(createSDMock).not.toHaveBeenCalled()
    expect(advanceStageMock).not.toHaveBeenCalled()
  })

  it("returns skipped when tax_returns row not found", async () => {
    trFixture = null
    const result = await syncTaxReturnToSD("tr-1")
    expect(result.action).toBe("skipped")
    expect(result.reason).toMatch(/not found/)
  })

  it("returns skipped when TR status has no SD mapping", async () => {
    trFixture = { ...trFixture!, status: "Unknown Status" }
    const result = await syncTaxReturnToSD("tr-1")
    expect(result.action).toBe("skipped")
    expect(result.reason).toMatch(/no SD stage mapping/)
  })

  it("returns skipped when tax_returns row has no account_id", async () => {
    trFixture = { ...trFixture!, account_id: null }
    const result = await syncTaxReturnToSD("tr-1")
    expect(result.action).toBe("skipped")
    expect(result.reason).toMatch(/no account_id/)
  })

  it("creates an SD via createSD when no active SD exists", async () => {
    sdFixture = null
    createSDMock.mockResolvedValueOnce({
      id: "sd-new",
      service_type: "Tax Return",
      service_name: "Tax Return 2024 - Acme LLC",
      stage: "Data Received",
      stage_order: 3,
      account_id: "acct-1",
      contact_id: "contact-1",
    })

    const result = await syncTaxReturnToSD("tr-1")

    expect(result.action).toBe("created")
    expect(result.delivery_id).toBe("sd-new")
    expect(result.to_stage).toBe("Data Received")
    expect(advanceStageMock).not.toHaveBeenCalled()
    expect(createSDMock).toHaveBeenCalledWith({
      service_type: "Tax Return",
      service_name: "Tax Return 2024 - Acme LLC",
      account_id: "acct-1",
      contact_id: "contact-1",
      target_stage: "Data Received",
      target_stage_order: 3,
      notes: expect.stringContaining("Auto-created from tax-return tab"),
    })
  })

  it("returns noop when SD is already at the target stage", async () => {
    sdFixture = {
      id: "sd-1",
      stage: "Data Received",
      stage_order: 3,
      status: "active",
    }

    const result = await syncTaxReturnToSD("tr-1")

    expect(result.action).toBe("noop")
    expect(result.delivery_id).toBe("sd-1")
    expect(result.to_stage).toBe("Data Received")
    expect(createSDMock).not.toHaveBeenCalled()
    expect(advanceStageMock).not.toHaveBeenCalled()
  })

  it("advances the SD with actor='tax-return-tab' when current stage differs", async () => {
    sdFixture = {
      id: "sd-1",
      stage: "Paid - Awaiting Data",
      stage_order: 0,
      status: "active",
    }
    advanceStageMock.mockResolvedValueOnce({
      success: true,
      from_stage: "Paid - Awaiting Data",
      to_stage: "Data Received",
      to_order: 3,
      total_stages: 12,
      is_completed: false,
      created_tasks: [],
      failed_tasks: [],
      auto_triggers: [],
    })

    const result = await syncTaxReturnToSD("tr-1")

    expect(result.action).toBe("advanced")
    expect(result.delivery_id).toBe("sd-1")
    expect(result.from_stage).toBe("Paid - Awaiting Data")
    expect(result.to_stage).toBe("Data Received")
    expect(advanceStageMock).toHaveBeenCalledWith({
      delivery_id: "sd-1",
      target_stage: "Data Received",
      actor: TAX_RETURN_SD_ACTOR,
    })
    expect(createSDMock).not.toHaveBeenCalled()
  })

  it("returns skipped (does not throw) when createSD fails", async () => {
    sdFixture = null
    createSDMock.mockRejectedValueOnce(new Error("catalog lookup boom"))

    const result = await syncTaxReturnToSD("tr-1")

    expect(result.action).toBe("skipped")
    expect(result.reason).toMatch(/createSD failed/)
    expect(result.reason).toMatch(/catalog lookup boom/)
  })

  it("returns skipped when advanceStage returns success=false (e.g. approval gate)", async () => {
    sdFixture = {
      id: "sd-1",
      stage: "Paid - Awaiting Data",
      stage_order: 0,
      status: "active",
    }
    advanceStageMock.mockResolvedValueOnce({
      success: false,
      error: "Requires approval",
      from_stage: "Paid - Awaiting Data",
      to_stage: "Data Received",
      to_order: 3,
      total_stages: 12,
      is_completed: false,
      created_tasks: [],
      failed_tasks: [],
      auto_triggers: [],
      requires_approval: true,
    })

    const result = await syncTaxReturnToSD("tr-1")

    expect(result.action).toBe("skipped")
    expect(result.delivery_id).toBe("sd-1")
    expect(result.reason).toBe("Requires approval")
  })

  it("returns skipped when advanceStage throws", async () => {
    sdFixture = {
      id: "sd-1",
      stage: "Paid - Awaiting Data",
      stage_order: 0,
      status: "active",
    }
    advanceStageMock.mockRejectedValueOnce(new Error("DB timeout"))

    const result = await syncTaxReturnToSD("tr-1")

    expect(result.action).toBe("skipped")
    expect(result.reason).toMatch(/advanceStage threw/)
    expect(result.reason).toMatch(/DB timeout/)
  })

  it("falls back to current year when tax_year is null on createSD path", async () => {
    sdFixture = null
    trFixture = { ...trFixture!, tax_year: null }
    createSDMock.mockResolvedValueOnce({
      id: "sd-new",
      service_type: "Tax Return",
      service_name: "x",
      stage: "Data Received",
      stage_order: 3,
      account_id: "acct-1",
      contact_id: "contact-1",
    })

    await syncTaxReturnToSD("tr-1")

    const args = createSDMock.mock.calls[0][0] as { service_name: string }
    const currentYear = new Date().getFullYear()
    expect(args.service_name).toContain(String(currentYear))
  })
})
