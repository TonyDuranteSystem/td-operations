/**
 * Identity build step 1 — the institution registry is CATALOG DATA merged over
 * the reviewed code seed (Antonio's ruling: staff add/reclassify an
 * institution without a deploy). The merge rules are the safety story:
 * catalog wins per institution, seed rows survive deletion, an invalid mode
 * degrades to the conservative account_number default, and a read failure
 * serves the seed alone — identity resolution can never go dark.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = {
  rows: [] as Array<{ display_name: string | null; metadata: Record<string, unknown> | null }>,
  error: null as string | null,
}
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => (state.error ? { data: null, error: { message: state.error } } : { data: state.rows, error: null }),
        }),
      }),
    }),
  },
}))

import { mergeRegistry, loadInstitutionRegistry, __clearRegistryCache } from "@/lib/tax/institution-registry"
import { INSTITUTION_SEED, resolveInstitution } from "@/lib/tax/bank-identity"

beforeEach(() => {
  state.rows = []
  state.error = null
  __clearRegistryCache()
})

describe("mergeRegistry", () => {
  it("a catalog row OVERRIDES the seed entry for the same institution (reclassify without a deploy)", () => {
    const merged = mergeRegistry(INSTITUTION_SEED, [
      { display_name: "Mercury", metadata: { identity_mode: "currency", match_terms: ["mercury"] } },
    ])
    const mercury = merged.find(e => e.canonical === "Mercury")
    expect(mercury?.mode).toBe("currency")
  })

  // ── Bug-hunter 2026-08-13: the two pre-migration failure shapes ──

  it("a MODE-LESS catalog row keeps the SEED's reviewed mode — pre-migration prod rows must not demand numbers from Wise clients", () => {
    const merged = mergeRegistry(INSTITUTION_SEED, [
      { display_name: "Wise", metadata: { match_terms: ["wise"] } }, // prod shape today: no identity_mode
    ])
    expect(merged.find(e => e.canonical === "Wise")?.mode).toBe("currency")
  })

  it("match_terms UNION with the seed — a narrower catalog list never un-knows a reviewed alias", () => {
    const merged = mergeRegistry(INSTITUTION_SEED, [
      { display_name: "Chase", metadata: { match_terms: ["chase", "jpmorgan"] } }, // prod's 3-term shape (narrower than seed's 11)
    ])
    const chase = merged.find(e => e.canonical === "Chase")
    // The seed's long-form alias survives: "JPMorgan Chase Bank, N.A." still resolves.
    expect(resolveInstitution("JPMorgan Chase Bank, N.A.", merged)).toEqual({ canonical: "Chase", mode: "account_number", matched: true })
    expect(chase?.matchTerms).toContain("jpmorgan chase bank na")
  })

  it("a staff-added institution resolves by its display name even with no aliases", () => {
    const merged = mergeRegistry(INSTITUTION_SEED, [
      { display_name: "Grasshopper", metadata: { identity_mode: "account_number" } },
    ])
    expect(resolveInstitution("Grasshopper", merged)).toEqual({ canonical: "Grasshopper", mode: "account_number", matched: true })
  })

  it("seed institutions with NO catalog row survive (deleting a row never un-knows a bank)", () => {
    const merged = mergeRegistry(INSTITUTION_SEED, [{ display_name: "Mercury", metadata: null }])
    expect(merged.find(e => e.canonical === "Kraken")?.mode).toBe("crypto")
    expect(merged.find(e => e.canonical === "Wells Fargo")?.mode).toBe("account_number")
  })

  it("an invalid/absent identity_mode degrades to account_number — the conservative default", () => {
    const merged = mergeRegistry([], [
      { display_name: "OddBank", metadata: { identity_mode: "banana" } },
      { display_name: "NoModeBank", metadata: {} },
    ])
    expect(merged.find(e => e.canonical === "OddBank")?.mode).toBe("account_number")
    expect(merged.find(e => e.canonical === "NoModeBank")?.mode).toBe("account_number")
  })

  it("junk rows are skipped, junk terms filtered", () => {
    const merged = mergeRegistry([], [
      { display_name: "  ", metadata: { identity_mode: "currency" } },
      { display_name: "Real", metadata: { match_terms: ["ok", "", 42, null] } },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].matchTerms).toEqual(["ok", "Real"])
  })
})

describe("loadInstitutionRegistry", () => {
  it("merges live catalog rows over the seed", async () => {
    state.rows = [{ display_name: "Mercury", metadata: { identity_mode: "currency", match_terms: ["mercury"] } }]
    const reg = await loadInstitutionRegistry()
    expect(reg.find(e => e.canonical === "Mercury")?.mode).toBe("currency")
    expect(reg.find(e => e.canonical === "Chase")?.mode).toBe("account_number") // seed survivor
  })

  it("serves the SEED alone when the catalog read fails — never throws, never empty", async () => {
    state.error = "connection refused"
    const reg = await loadInstitutionRegistry()
    expect(reg).toEqual(INSTITUTION_SEED)
  })

  it("caches — a second call within the window does not refetch", async () => {
    state.rows = [{ display_name: "Mercury", metadata: { identity_mode: "currency" } }]
    const first = await loadInstitutionRegistry()
    state.rows = [] // would change the result if refetched
    const second = await loadInstitutionRegistry()
    expect(second).toBe(first)
  })
})
