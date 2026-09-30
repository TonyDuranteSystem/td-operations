import { describe, it, expect } from "vitest"
import { entityRowToBillTo } from "@/lib/invoice-bill-to"

describe("entityRowToBillTo", () => {
  it("prints the entity's name, address + country, VAT", () => {
    expect(entityRowToBillTo({ entity_name: " Rossi Srl ", billing_address: "Via Roma 1, Milano", country: "Italy", vat_number: "IT123" }))
      .toEqual({ name: "Rossi Srl", address: "Via Roma 1, Milano, Italy", vatNumber: "IT123" })
  })
  it("falls back to the fiscal code when there is no VAT", () => {
    expect(entityRowToBillTo({ entity_name: "Mario Rossi", fiscal_code: "RSSMRA80A01F205X" })?.vatNumber).toBe("RSSMRA80A01F205X")
  })
  it("no row / no name → null (the invoice keeps its usual Bill To)", () => {
    expect(entityRowToBillTo(null)).toBeNull()
    expect(entityRowToBillTo({ entity_name: "  " })).toBeNull()
  })
  it("missing address parts are left out", () => {
    expect(entityRowToBillTo({ entity_name: "X", country: "Malta" })?.address).toBe("Malta")
    expect(entityRowToBillTo({ entity_name: "X" })?.address).toBeNull()
  })
})
