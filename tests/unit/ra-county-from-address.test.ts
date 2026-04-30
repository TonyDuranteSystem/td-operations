import { describe, it, expect } from "vitest"
import { countyFromRAAddress, KNOWN_RA_CANONICALS } from "@/lib/ra/county-from-ra-address"

/**
 * Tests for the SS-4 Line 6 lookup helper.
 *
 * Rules under test (per Antonio's TD operating rule, 2026-04-30):
 * - Line 6 = county/state of the registered agent / registered office address
 * - Never derived from formation state, owner address, or account.physical_address
 * - Unknown/blank/unmappable address → null (caller blocks SS-4)
 * - No global Pinellas default
 * - No state-to-county fallback
 */

describe("countyFromRAAddress — known addresses", () => {
  it("Sheridan WY (30 N Gould) → Sheridan County, Wyoming", () => {
    const r = countyFromRAAddress("30 N Gould St STE R, Sheridan WY 82801")
    expect(r?.countyAndState).toBe("Sheridan County, Wyoming")
  })

  it("Sheridan WY (1095 Sugar View) → Sheridan County, Wyoming", () => {
    const r = countyFromRAAddress("1095 Sugar View Dr STE 500, Sheridan WY 82801")
    expect(r?.countyAndState).toBe("Sheridan County, Wyoming")
  })

  it("Cheyenne WY (1507 Lampman) → Laramie County, Wyoming — NOT Sheridan", () => {
    const r = countyFromRAAddress("1507 Lampman Ct, Cheyenne WY 82007")
    expect(r?.countyAndState).toBe("Laramie County, Wyoming")
    expect(r?.countyAndState).not.toBe("Sheridan County, Wyoming")
  })

  it("St. Petersburg FL (7901 4th St N) → Pinellas County, Florida", () => {
    const r = countyFromRAAddress("7901 4th St N STE 300, St. Petersburg FL 33702")
    expect(r?.countyAndState).toBe("Pinellas County, Florida")
  })

  it("Plantation FL (1200 S Pine Island) → Broward County, Florida — NOT Pinellas", () => {
    const r = countyFromRAAddress("1200 S Pine Island Rd STE 200, Plantation FL 33324")
    expect(r?.countyAndState).toBe("Broward County, Florida")
    expect(r?.countyAndState).not.toBe("Pinellas County, Florida")
  })

  it("Lewes DE (16192 Coastal Highway) → Sussex County, Delaware", () => {
    const r = countyFromRAAddress("16192 Coastal Highway, Lewes DE 19958")
    expect(r?.countyAndState).toBe("Sussex County, Delaware")
  })

  it("Albuquerque NM (1209 Mountain Road) → Bernalillo County, New Mexico", () => {
    const r = countyFromRAAddress("1209 Mountain Road Pl NE STE R, Albuquerque NM 87110")
    expect(r?.countyAndState).toBe("Bernalillo County, New Mexico")
  })

  it("Albuquerque NM (2929 Coors Blvd — UCCIO alternate) → Bernalillo County, New Mexico", () => {
    const r = countyFromRAAddress("2929 Coors Blvd NW STE 101, Albuquerque NM 87120")
    expect(r?.countyAndState).toBe("Bernalillo County, New Mexico")
  })
})

describe("countyFromRAAddress — formatting variants of the same physical location", () => {
  it("WY Sheridan: comma-less / Ste vs STE / missing-state / missing-zip", () => {
    expect(countyFromRAAddress("30 N Gould St, STE R, Sheridan, 82801")?.countyAndState).toBe("Sheridan County, Wyoming")
    expect(countyFromRAAddress("30 N Gould St Ste R, Sheridan, WY 82801")?.countyAndState).toBe("Sheridan County, Wyoming")
    expect(countyFromRAAddress("30 N GOULD ST STE R SHERIDAN WY 82801")?.countyAndState).toBe("Sheridan County, Wyoming")
    expect(countyFromRAAddress("30 n gould st sheridan")?.countyAndState).toBe("Sheridan County, Wyoming")
  })

  it("NM Albuquerque (1209): three real-world variants from production data all match", () => {
    expect(countyFromRAAddress("1209 Mountain Road PL NE STE R, Albuquerque, 87110")?.countyAndState).toBe("Bernalillo County, New Mexico")
    expect(countyFromRAAddress("1209 Mountain Road Pl NE, Ste R, Albuquerque, NM 87110")?.countyAndState).toBe("Bernalillo County, New Mexico")
    expect(countyFromRAAddress("1209 Mountain Road Pl NE, STE R, Albuquerque, NM 87110")?.countyAndState).toBe("Bernalillo County, New Mexico")
  })

  it("FL St. Petersburg: comma vs no-comma, period vs no-period", () => {
    expect(countyFromRAAddress("7901 4th St N, STE 300, St. Petersburg, 33702")?.countyAndState).toBe("Pinellas County, Florida")
    expect(countyFromRAAddress("7901 4th St N STE 300, St. Petersburg, FL 33702")?.countyAndState).toBe("Pinellas County, Florida")
    expect(countyFromRAAddress("7901 4th St N STE 300 St Petersburg FL 33702")?.countyAndState).toBe("Pinellas County, Florida")
  })

  it("DE Lewes: case variants", () => {
    expect(countyFromRAAddress("16192 COASTAL HIGHWAY, LEWES, 19958")?.countyAndState).toBe("Sussex County, Delaware")
    expect(countyFromRAAddress("16192 coastal highway, lewes de 19958")?.countyAndState).toBe("Sussex County, Delaware")
  })
})

describe("countyFromRAAddress — null cases (caller must block SS-4)", () => {
  it("blank string returns null", () => {
    expect(countyFromRAAddress("")).toBeNull()
  })

  it("whitespace-only returns null", () => {
    expect(countyFromRAAddress("   \t\n  ")).toBeNull()
  })

  it("null input returns null", () => {
    expect(countyFromRAAddress(null)).toBeNull()
  })

  it("undefined input returns null", () => {
    expect(countyFromRAAddress(undefined)).toBeNull()
  })

  it("unknown address returns null — no guess, no fallback", () => {
    expect(countyFromRAAddress("123 Fake Street, Nowhere TX 00000")).toBeNull()
    expect(countyFromRAAddress("100 Main Street, Sheridan WY 82801")).toBeNull() // wrong number, right city — must NOT match
    expect(countyFromRAAddress("30 Some Other Road, Sheridan WY 82801")).toBeNull() // right number+city but wrong street
  })

  it("partial match (only city, no street number) returns null", () => {
    expect(countyFromRAAddress("Sheridan WY 82801")).toBeNull()
    expect(countyFromRAAddress("Albuquerque NM 87110")).toBeNull()
    expect(countyFromRAAddress("Lewes DE 19958")).toBeNull()
  })
})

describe("countyFromRAAddress — invariants (no leakage from other sources)", () => {
  it("formation state code alone does not match — no state-to-county fallback", () => {
    expect(countyFromRAAddress("NM")).toBeNull()
    expect(countyFromRAAddress("WY")).toBeNull()
    expect(countyFromRAAddress("FL")).toBeNull()
    expect(countyFromRAAddress("DE")).toBeNull()
    expect(countyFromRAAddress("New Mexico")).toBeNull()
    expect(countyFromRAAddress("Wyoming")).toBeNull()
    expect(countyFromRAAddress("Florida")).toBeNull()
    expect(countyFromRAAddress("Delaware")).toBeNull()
  })

  it("owner state province strings (Italian provinces / countries) never match", () => {
    expect(countyFromRAAddress("italy")).toBeNull()
    expect(countyFromRAAddress("Italy")).toBeNull()
    expect(countyFromRAAddress("Padova")).toBeNull()
    expect(countyFromRAAddress("Milano")).toBeNull()
    expect(countyFromRAAddress("Roma")).toBeNull()
  })

  it("TD office (Largo FL mailing address) never produces Pinellas — it is not an RA address", () => {
    expect(countyFromRAAddress("10225 Ulmerton Rd 3D, Largo FL 33771")).toBeNull()
    expect(countyFromRAAddress("10225 Ulmerton Rd 3D Largo FL 33771")).toBeNull()
  })

  it("account.physical_address-shaped strings (company location) do not produce a county", () => {
    // physical_address is the company's business address; it must never resolve Line 6.
    expect(countyFromRAAddress("Via Roma 12, Padova, Italy 35100")).toBeNull()
    expect(countyFromRAAddress("123 Office Park Dr, Tampa FL 33602")).toBeNull()
  })

  it("no global Pinellas default — must come from a recognized FL RA address", () => {
    // If we ever introduce a default, this test will fail and force an explicit decision.
    expect(countyFromRAAddress("anything")).toBeNull()
    expect(countyFromRAAddress("foo bar baz")).toBeNull()
  })
})

describe("countyFromRAAddress — match metadata", () => {
  it("returns matchedCanonical and source for traceability", () => {
    const r = countyFromRAAddress("1209 Mountain Road Pl NE, Ste R, Albuquerque, NM 87110")
    expect(r).not.toBeNull()
    expect(r?.matchedCanonical).toContain("1209 Mountain Road")
    expect(r?.source).toBe("ra-address-known")
  })

  it("KNOWN_RA_CANONICALS exposes 8 entries covering all production RA addresses", () => {
    expect(KNOWN_RA_CANONICALS).toHaveLength(8)
    const states = KNOWN_RA_CANONICALS.map((e) => e.countyAndState)
    expect(states).toContain("Sheridan County, Wyoming")
    expect(states).toContain("Laramie County, Wyoming")
    expect(states).toContain("Pinellas County, Florida")
    expect(states).toContain("Broward County, Florida")
    expect(states).toContain("Sussex County, Delaware")
    expect(states).toContain("Bernalillo County, New Mexico")
  })
})
