/**
 * Phase 0 — entity-type-from-contract helper.
 *
 * Covers every branch of getEntityTypeFromContract so the account-creation
 * + activation flow can rely on deterministic mapping without re-asserting
 * the shape at every call site.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface ContractFixture {
  llc_type: string | null
}

let contractFixture: ContractFixture | null = null

function buildContractsChain() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(() => Promise.resolve({ data: contractFixture, error: null })),
  }
  return chain
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "contracts") return buildContractsChain()
      throw new Error(`Unexpected table in helper test: ${table}`)
    },
  },
}))

import { getEntityTypeFromContract } from "@/lib/portal/entity-type-from-contract"

beforeEach(() => {
  contractFixture = null
})

describe("getEntityTypeFromContract", () => {
  it("returns no_token when offerToken is missing", async () => {
    const result = await getEntityTypeFromContract(undefined)
    expect(result.source).toBe("no_token")
    expect(result.wizardCode).toBeNull()
    expect(result.accountLabel).toBeNull()
    expect(result.rawLlcType).toBeNull()
  })

  it("returns no_token when offerToken is null", async () => {
    const result = await getEntityTypeFromContract(null)
    expect(result.source).toBe("no_token")
    expect(result.wizardCode).toBeNull()
    expect(result.accountLabel).toBeNull()
  })

  it("returns no_token when offerToken is empty string", async () => {
    const result = await getEntityTypeFromContract("")
    expect(result.source).toBe("no_token")
  })

  it("returns no_contract when no signed contract row exists", async () => {
    contractFixture = null
    const result = await getEntityTypeFromContract("token-with-no-contract")
    expect(result.source).toBe("no_contract")
    expect(result.wizardCode).toBeNull()
    expect(result.accountLabel).toBeNull()
    expect(result.rawLlcType).toBeNull()
  })

  it("returns no_contract when contract row has null llc_type", async () => {
    contractFixture = { llc_type: null }
    const result = await getEntityTypeFromContract("token-partial-contract")
    expect(result.source).toBe("no_contract")
    expect(result.accountLabel).toBeNull()
  })

  it("maps SMLLC to Single Member LLC", async () => {
    contractFixture = { llc_type: "SMLLC" }
    const result = await getEntityTypeFromContract("token-smllc")
    expect(result.source).toBe("contract")
    expect(result.wizardCode).toBe("SMLLC")
    expect(result.accountLabel).toBe("Single Member LLC")
    expect(result.rawLlcType).toBe("SMLLC")
  })

  it("maps MMLLC to Multi Member LLC", async () => {
    contractFixture = { llc_type: "MMLLC" }
    const result = await getEntityTypeFromContract("token-mmllc")
    expect(result.source).toBe("contract")
    expect(result.wizardCode).toBe("MMLLC")
    expect(result.accountLabel).toBe("Multi Member LLC")
    expect(result.rawLlcType).toBe("MMLLC")
  })

  it("maps Corporation to C-Corp Elected with corporation_not_wired source (wizardCode null so callers skip auto-wizard)", async () => {
    contractFixture = { llc_type: "Corporation" }
    const result = await getEntityTypeFromContract("token-ccorp")
    expect(result.source).toBe("corporation_not_wired")
    expect(result.wizardCode).toBeNull()
    expect(result.accountLabel).toBe("C-Corp Elected")
    expect(result.rawLlcType).toBe("Corporation")
  })

  it("flags unknown_type for llc_type values we don't recognize (preserves rawLlcType for diagnostics)", async () => {
    contractFixture = { llc_type: "PartnershipOrSomethingWeird" }
    const result = await getEntityTypeFromContract("token-unknown")
    expect(result.source).toBe("unknown_type")
    expect(result.wizardCode).toBeNull()
    expect(result.accountLabel).toBeNull()
    expect(result.rawLlcType).toBe("PartnershipOrSomethingWeird")
  })

  it("is case-sensitive on llc_type values (lowercase smllc is treated as unknown, not SMLLC)", async () => {
    contractFixture = { llc_type: "smllc" }
    const result = await getEntityTypeFromContract("token-lowercase")
    expect(result.source).toBe("unknown_type")
    expect(result.rawLlcType).toBe("smllc")
  })
})
