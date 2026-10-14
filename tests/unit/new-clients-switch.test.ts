import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) } }))
vi.mock("@/lib/google-drive-guard", () => ({ isProductionDatabase: (env: Record<string, string | undefined>) => (env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs") }))

import { newClientsLive, formationStoreAllowed, pilotEnvironmentAllowed, isStorePilotContact } from "@/lib/crm-store/formation-pilot"

describe("the new-clients switch", () => {
  it("is off unless STORE_NEW_CLIENTS is exactly 1", () => {
    expect(newClientsLive({})).toBe(false)
    expect(newClientsLive({ STORE_NEW_CLIENTS: "true" })).toBe(false)
    expect(newClientsLive({ STORE_NEW_CLIENTS: "0" })).toBe(false)
    expect(newClientsLive({ STORE_NEW_CLIENTS: "1" })).toBe(true)
  })
  it("opens the formation machinery in production only with the switch (the sandbox pilot stays sandbox-only)", () => {
    const prod = { NEXT_PUBLIC_SUPABASE_URL: "https://ydzipybqeebtpcvsbtvs.supabase.co" }
    expect(formationStoreAllowed(prod)).toBe(false)
    expect(formationStoreAllowed({ ...prod, STORE_NEW_CLIENTS: "1" })).toBe(true)
    expect(pilotEnvironmentAllowed({ ...prod, STORE_NEW_CLIENTS: "1" })).toBe(false)
    expect(formationStoreAllowed({ SANDBOX_MODE: "1", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toBe(true)
  })
  it("with the switch on, every buyer counts as a store buyer; without it, nobody is (no list on file)", async () => {
    expect(await isStorePilotContact("c1", { STORE_NEW_CLIENTS: "1" })).toBe(true)
    expect(await isStorePilotContact(null, { STORE_NEW_CLIENTS: "1" })).toBe(false)
    expect(await isStorePilotContact("c1", {})).toBe(false)
  })
})
