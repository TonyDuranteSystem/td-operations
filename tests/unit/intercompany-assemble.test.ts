/**
 * assembleIntercompanyInput — pure assembly of the Intercompany Transfer
 * Agreement input from CRM rows (lib/operations/intercompany.ts).
 *
 * Origin: Umberto Moretti incident (2026-07-07) — the manually-produced ICA
 * for Azarexa ↔ Advertising Apex carried a wrong ownership % (1% vs 99%) and
 * a stale address. The assembler must take BOTH from the CRM and refuse to
 * generate when data is missing, never fall back to invented values.
 */

import { describe, it, expect } from "vitest"
import {
  assembleIntercompanyInput,
  type IcaAccountData,
  type IcaMemberRow,
} from "@/lib/operations/intercompany"

const operatingAccount: IcaAccountData = {
  id: "acc-op",
  company_name: "Azarexa LLC",
  state_of_formation: "New Mexico",
  ein_number: "35-2947727",
  physical_address: "10225 Ulmerton Rd, Suite 3D-306, Largo, FL 33771",
}

const treasuryAccount: IcaAccountData = {
  id: "acc-tr",
  company_name: "Advertising Apex LLC",
  state_of_formation: "Florida",
  ein_number: "37-2099151",
  physical_address: "10225 Ulmerton Rd, Suite 3D-205, Largo, FL 33771",
}

function member(overrides: Partial<IcaMemberRow>): IcaMemberRow {
  return {
    id: "m1",
    member_type: "individual",
    full_name: null,
    company_name: null,
    ownership_pct: null,
    is_primary: false,
    ein: null,
    address_street: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    address_country: null,
    ...overrides,
  }
}

const companyMember = member({
  id: "m-apex",
  member_type: "company",
  company_name: "Advertising Apex LLC",
  ownership_pct: 99,
})

const individualMember = member({
  id: "m-umberto",
  member_type: "individual",
  full_name: "Umberto Moretti",
  ownership_pct: 1,
  is_primary: true,
})

describe("assembleIntercompanyInput", () => {
  it("builds the full input from CRM data (ownership + addresses from CRM, never invented)", () => {
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [individualMember, companyMember],
      treasuryAccount,
      effectiveDate: "2026-07-07",
      oaEffectiveDate: "2026-02-20",
    })
    expect(result.error).toBeUndefined()
    expect(result.input).toMatchObject({
      operatingCompanyName: "Azarexa LLC",
      operatingCompanyState: "New Mexico",
      operatingCompanyEin: "35-2947727",
      operatingCompanyAddress: "10225 Ulmerton Rd, Suite 3D-306, Largo, FL 33771",
      treasuryCompanyName: "Advertising Apex LLC",
      treasuryCompanyState: "Florida",
      treasuryCompanyEin: "37-2099151",
      treasuryCompanyAddress: "10225 Ulmerton Rd, Suite 3D-205, Largo, FL 33771",
      treasuryOwnershipPct: 99,
      managerName: "Umberto Moretti",
      effectiveDate: "2026-07-07",
      oaEffectiveDate: "2026-02-20",
    })
  })

  it("prefers the member row's own address and EIN over the treasury account fallback", () => {
    const filledMember = member({
      ...companyMember,
      ein: "11-1111111",
      address_street: "1 Member Row St",
      address_city: "Largo",
      address_state: "FL",
      address_zip: "33771",
    })
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [individualMember, filledMember],
      treasuryAccount,
      effectiveDate: "2026-07-07",
    })
    expect(result.input?.treasuryCompanyEin).toBe("11-1111111")
    expect(result.input?.treasuryCompanyAddress).toBe("1 Member Row St, Largo, FL, 33771")
  })

  it("errors when there is no company member (treasury)", () => {
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [individualMember],
      treasuryAccount,
      effectiveDate: "2026-07-07",
    })
    expect(result.error).toMatch(/no company member/i)
  })

  it("errors when there are multiple company members", () => {
    const second = member({ id: "m2", member_type: "company", company_name: "Other Holding LLC", ownership_pct: 10 })
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [individualMember, companyMember, second],
      treasuryAccount,
      effectiveDate: "2026-07-07",
    })
    expect(result.error).toMatch(/2 company members/i)
  })

  it("errors when the ownership percentage is missing — never invents a default", () => {
    const noPct = member({ ...companyMember, ownership_pct: null })
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [individualMember, noPct],
      treasuryAccount,
      effectiveDate: "2026-07-07",
    })
    expect(result.error).toMatch(/ownership percentage/i)
  })

  it("errors when no address is available anywhere for the treasury company", () => {
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [individualMember, companyMember],
      treasuryAccount: { ...treasuryAccount, physical_address: null },
      effectiveDate: "2026-07-07",
    })
    expect(result.error).toMatch(/no address on file/i)
  })

  it("errors when the treasury company has no CRM account for its state of formation", () => {
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [
        individualMember,
        member({ ...companyMember, address_street: "1 St", address_city: "Largo" }),
      ],
      treasuryAccount: null,
      effectiveDate: "2026-07-07",
    })
    expect(result.error).toMatch(/state of formation/i)
  })

  it("errors when the operating account is missing its address", () => {
    const result = assembleIntercompanyInput({
      operatingAccount: { ...operatingAccount, physical_address: null },
      members: [individualMember, companyMember],
      treasuryAccount,
      effectiveDate: "2026-07-07",
    })
    expect(result.error).toMatch(/physical_address/i)
  })

  it("falls back to the primary contact name when there is no individual member", () => {
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [companyMember],
      treasuryAccount,
      primaryContactName: "Umberto Moretti",
      effectiveDate: "2026-07-07",
    })
    expect(result.input?.managerName).toBe("Umberto Moretti")
  })

  it("errors when no manager can be determined", () => {
    const result = assembleIntercompanyInput({
      operatingAccount,
      members: [companyMember],
      treasuryAccount,
      primaryContactName: null,
      effectiveDate: "2026-07-07",
    })
    expect(result.error).toMatch(/no manager/i)
  })
})
