import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import OperatingAgreementTemplate from "@/components/portal/operating-agreement-template"

const members = [
  { fullName: "Giulia Schiavoni", address: "Bologna", ownershipPct: 50, isSigner: true },
  { fullName: "Caterina Levoni", address: "Bologna", ownershipPct: 50 },
]
const account = {
  companyName: "Beril LLC", ein: "85-0703779", stateOfFormation: "Florida", formationDate: "2020-04-09",
  physicalAddress: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771", entityType: "Multi Member LLC",
  registeredAgentAddress: "x", managerName: "Antonio Durante",
}
const html = (extra: object) =>
  renderToStaticMarkup(createElement(OperatingAgreementTemplate, { account: { ...account, ...extra }, members, effectiveDate: "2026-10-22" }))

describe("portal Generate Documents preview — Section 2.3", () => {
  it("default: Manager only (unchanged)", () => {
    const h = html({})
    expect(h).toContain("full and exclusive authority")
    expect(h).toContain("No Member, solely by virtue of being a Member, shall have the authority to bind the Company.")
  })
  it("membersMaySign on: the Manager and each Member may sign", () => {
    const h = html({ membersMaySign: true })
    expect(h).toContain("The Manager shall have full authority")
    expect(h).not.toContain("full and exclusive authority")
    expect(h).not.toContain("No Member, solely by virtue")
    expect(h).toContain("The Manager and each Member, acting alone, may also sign")
  })
})
