import { describe, it, expect } from "vitest"
import { parsePassportFromOcr } from "../../lib/passport-processing"

// Real OCR output shape from Document AI. The key thing this file locks in
// is the split MRZ + "DD MMM YYYY" Italian date handling that went missing
// before dev_task 3274fdf6 — Luca Gallacci's passport on 2026-04-18 had its
// passport_number extracted but expiry_date / DOB / nationality dropped.

const ITALIAN_PASSPORT_SAMPLE = `
PASSAPORTO
REPUBBLICA ITALIANA
Tipo. Codice Paese. Passaporto N.
P
ITA
Cognome. (1)
GALLACCI
Nome. (2)
LUCA
Cittadinanza. (3)
ITALIANA
Data di nascita. (4)
10 DIC/DEC 2000
YB7472219
Sesso. (5)
M
Data di scadenza. Date of expiry. (8)
14 MAR/MAR 2031
P<ITAGALLACCI<<LUCA<<<<<<<<<<<<
<<<<<<<<
YB74722195ITA0012108M3103142<<<<<<<<<<<<<<02
`

describe("parsePassportFromOcr — MRZ data line", () => {
  it("extracts all fields from a split-line Italian passport", () => {
    const result = parsePassportFromOcr(ITALIAN_PASSPORT_SAMPLE)
    expect(result.passportNumber).toBe("YB7472219")
    expect(result.nationality).toBe("ITA")
    expect(result.dateOfBirth).toBe("2000-12-10")
    expect(result.expiryDate).toBe("2031-03-14")
    expect(result.fullName).toBe("LUCA GALLACCI")
  })

  it("parses expiry from the MRZ data line alone, without the name line", () => {
    const dataLineOnly = "YB74722195ITA0012108M3103142<<<<<<<<<<<<<<02"
    const result = parsePassportFromOcr(dataLineOnly)
    expect(result.expiryDate).toBe("2031-03-14")
    expect(result.dateOfBirth).toBe("2000-12-10")
    expect(result.passportNumber).toBe("YB7472219")
    expect(result.nationality).toBe("ITA")
  })

  it("returns nulls for text with no MRZ-like content", () => {
    const result = parsePassportFromOcr("Just some regular paragraph text.\nNo passport data.")
    expect(result.passportNumber).toBeNull()
    expect(result.expiryDate).toBeNull()
  })
})

describe("parsePassportFromOcr — visual text fallback", () => {
  it("extracts expiry from 'DD MMM YYYY' abbrev format (Italian + English)", () => {
    const text = `
    Data di scadenza. Date of expiry. (8)
    14 MAR/MAR 2031
    `
    const result = parsePassportFromOcr(text)
    expect(result.expiryDate).toBe("2031-03-14")
  })

  it("extracts expiry from 'DD MMM YYYY' with only one abbreviation", () => {
    const text = "Date of expiry: 05 DEC 2029"
    const result = parsePassportFromOcr(text)
    expect(result.expiryDate).toBe("2029-12-05")
  })

  it("extracts DOB from Italian 'Data di nascita' with abbrev month", () => {
    const text = `
    Data di nascita. Date of birth. (4)
    10 DIC/DEC 2000
    `
    const result = parsePassportFromOcr(text)
    expect(result.dateOfBirth).toBe("2000-12-10")
  })

  it("still handles numeric dd/mm/yyyy expiry from older passports", () => {
    const text = "Date of expiry: 14/03/2031"
    const result = parsePassportFromOcr(text)
    expect(result.expiryDate).toBe("2031-03-14")
  })

  it("returns null expiry when the date is unrecoverable", () => {
    const text = "Date of expiry: sometime in the future"
    const result = parsePassportFromOcr(text)
    expect(result.expiryDate).toBeNull()
  })
})

describe("parsePassportFromOcr — MRZ name line reconstruction", () => {
  it("reconstructs the full name across split MRZ lines", () => {
    const text = `
    P<ITAGALLACCI<<LUCA<<<<<<<<<<<<
    <<<<<<<<
    YB74722195ITA0012108M3103142<<<<<<<<<<<<<<02
    `
    const result = parsePassportFromOcr(text)
    expect(result.fullName).toBe("LUCA GALLACCI")
  })

  it("handles multi-word given name", () => {
    const text = `
    P<ITAROSSI<<MARIO<CARLO<<<<<<<<<<<<<<<<<<<<<
    AB12345678ITA8501014M3001014<<<<<<<<<<<<<<02
    `
    const result = parsePassportFromOcr(text)
    expect(result.fullName).toBe("MARIO CARLO ROSSI")
  })
})
