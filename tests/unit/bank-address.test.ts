import { describe, it, expect } from "vitest"
import { euroBankAddress } from "@/lib/offers/bank-address"

describe("euroBankAddress — bank address only for the euro (IBAN) account", () => {
  it("euro account with the bank's address → the address", () => {
    expect(euroBankAddress({ iban: "DK8989000023658198", address: "Amerika Plads, 38, Copenhagen, Denmark, 2100" }))
      .toBe("Amerika Plads, 38, Copenhagen, Denmark, 2100")
  })
  it("prefers an explicit bank_address", () => {
    expect(euroBankAddress({ iban: "DK89", bank_address: "Bank St 1", address: "Other" })).toBe("Bank St 1")
  })
  it("US-dollar account (no IBAN) → null, its stored address is not the bank's", () => {
    expect(euroBankAddress({ address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771" })).toBeNull()
  })
  it("euro account without an address → null", () => {
    expect(euroBankAddress({ iban: "DK89", address: "  " })).toBeNull()
  })
  it("no bank details → null", () => {
    expect(euroBankAddress(null)).toBeNull()
    expect(euroBankAddress(undefined)).toBeNull()
  })
})
