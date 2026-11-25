/**
 * Portal home notice for a client whose companies are all OFFBOARDING (dev job 31dfd3a6).
 * An offboarding company is hidden from the portal like a closed one, so the client had no company and landed on the new-client
 * "Thank you for your payment! Complete your setup…" screen. Same rule as the closed-company notice; the login is not touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const state = vi.hoisted(() => ({
  links: [] as Array<{ account_id: string }>,
  accounts: [] as Array<{ id: string; company_name: string; status: string }>,
  seen: [] as Array<{ table: string; op: string; args: unknown[] }>,
}))

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const eqFilters: Array<[string, unknown]> = []
    const b: Record<string, unknown> = {}
    const chain = (op: string) => (...args: unknown[]) => {
      state.seen.push({ table, op, args })
      if (op === "eq") eqFilters.push([String(args[0]), args[1]])
      return b
    }
    for (const op of ["select", "is", "eq", "in", "order"]) b[op] = chain(op)
    b.then = (resolve: (v: { data: unknown }) => void) => {
      if (table === "account_contacts") return resolve({ data: state.links })
      const status = eqFilters.find(([k]) => k === "status")?.[1]
      return resolve({ data: state.accounts.filter((a) => a.status === status).sort((x, y) => x.company_name.localeCompare(y.company_name)) })
    }
    return b
  }
  return { supabaseAdmin: { from: builder } }
})

import { showOffboardingCompanyNotice, showClosedCompanyNotice } from "@/lib/portal/closed-company"
import { getOffboardingCompanyNames, getClosedCompanyNames } from "@/lib/portal/queries"
import { t } from "@/lib/portal/i18n"

const ROOT = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

describe("showOffboardingCompanyNotice", () => {
  it("shows when a company is offboarding and the latest offer is the finished one", () => {
    expect(showOffboardingCompanyNotice({ offboardingCompanyCount: 1, offerStatus: "completed" })).toBe(true)
    expect(showOffboardingCompanyNotice({ offboardingCompanyCount: 3, offerStatus: "Completed" })).toBe(true)
  })

  it("shows when the client has an offboarding company and no offer at all", () => {
    expect(showOffboardingCompanyNotice({ offboardingCompanyCount: 1, offerStatus: null })).toBe(true)
    expect(showOffboardingCompanyNotice({ offboardingCompanyCount: 1, offerStatus: undefined })).toBe(true)
  })

  it("keeps the welcome flow when something new is being bought", () => {
    for (const s of ["draft", "sent", "viewed", "signed"]) {
      expect(showOffboardingCompanyNotice({ offboardingCompanyCount: 1, offerStatus: s }), s).toBe(false)
    }
  })

  it("never shows for a client with no offboarding company (a real new client keeps the welcome screen)", () => {
    expect(showOffboardingCompanyNotice({ offboardingCompanyCount: 0, offerStatus: "completed" })).toBe(false)
    expect(showOffboardingCompanyNotice({ offboardingCompanyCount: 0, offerStatus: null })).toBe(false)
  })

  it("follows the very same rule as the closed-company notice", () => {
    for (const s of [null, undefined, "", "completed", "draft", "sent", "viewed", "signed"]) {
      for (const n of [0, 1, 2]) {
        expect(showOffboardingCompanyNotice({ offboardingCompanyCount: n, offerStatus: s })).toBe(showClosedCompanyNotice({ closedCompanyCount: n, offerStatus: s }))
      }
    }
  })
})

describe("offboarding-company texts", () => {
  it("exist in both languages, carry the company placeholder, and differ between languages", () => {
    for (const locale of ["en", "it"] as const) {
      for (const key of ["offboardingCompany.title", "offboardingCompany.chat"]) {
        expect(t(key, locale), `${locale} ${key}`).not.toBe(key)
      }
      expect(t("offboardingCompany.body", locale), locale).not.toBe("offboardingCompany.body")
      expect(t("offboardingCompany.body", locale)).toContain("{company}")
    }
    expect(t("offboardingCompany.title", "it")).not.toBe(t("offboardingCompany.title", "en"))
    expect(t("offboardingCompany.body", "it")).not.toBe(t("offboardingCompany.body", "en"))
  })

  it("promise nothing about documents or invoices (only the chat is offered)", () => {
    for (const locale of ["en", "it"] as const) {
      const body = t("offboardingCompany.body", locale).toLowerCase()
      expect(body).not.toMatch(/document|invoice|fattur|documenti/)
    }
  })
})

describe("getOffboardingCompanyNames", () => {
  beforeEach(() => {
    state.seen.length = 0
    state.links = [{ account_id: "a1" }, { account_id: "a2" }, { account_id: "a3" }]
    state.accounts = [
      { id: "a1", company_name: "Zeta LLC", status: "Offboarding" },
      { id: "a2", company_name: "Alpha LLC", status: "Offboarding" },
      { id: "a3", company_name: "Beta LLC", status: "Closed" },
    ]
  })

  it("returns only the Offboarding companies, in name order", async () => {
    expect(await getOffboardingCompanyNames("c1")).toEqual(["Alpha LLC", "Zeta LLC"])
  })

  it("asks for status Offboarding, only on non-revoked links of that contact", async () => {
    await getOffboardingCompanyNames("c1")
    expect(state.seen.some((s) => s.table === "accounts" && s.op === "eq" && s.args[0] === "status" && s.args[1] === "Offboarding")).toBe(true)
    expect(state.seen.some((s) => s.table === "account_contacts" && s.op === "is" && s.args[0] === "access_revoked_at" && s.args[1] === null)).toBe(true)
    expect(state.seen.some((s) => s.table === "account_contacts" && s.op === "eq" && s.args[0] === "contact_id" && s.args[1] === "c1")).toBe(true)
  })

  it("returns nothing for a contact with no links", async () => {
    state.links = []
    expect(await getOffboardingCompanyNames("c1")).toEqual([])
  })

  it("the closed lookup still returns only Closed companies (shared helper did not change it)", async () => {
    expect(await getClosedCompanyNames("c1")).toEqual(["Beta LLC"])
  })
})

describe("the portal home is wired to the offboarding notice", () => {
  const page = read("app/portal/page.tsx")
  const card = read("app/portal/offboarding-company-card.tsx")

  it("reads the offboarding companies, applies the rule, and draws the card next to the closed one", () => {
    expect(page).toContain("getOffboardingCompanyNames(contactId)")
    expect(page).toContain("showOffboardingCompanyNotice({ offboardingCompanyCount: offboardingCompanyNames.length, offerStatus: offerData?.status })")
    expect(page).toContain("<OffboardingCompanyCard companyNames={offboardingCompanyNames} />")
    expect(page).toContain("<ClosedCompanyCard companyNames={closedCompanyNames} />")
  })

  it("sits in the no-company branch, ahead of the new-client welcome dashboard", () => {
    const at = (s: string) => page.indexOf(s)
    expect(at("getOffboardingCompanyNames(contactId)")).toBeGreaterThan(at("if (!selectedAccountId || accounts.length === 0)"))
    // "tier={authTier}" is the new-client welcome dashboard of this same branch (the only WelcomeDashboard that takes it)
    expect(at("tier={authTier}")).toBeGreaterThan(-1)
    expect(at("getOffboardingCompanyNames(contactId)")).toBeLessThan(at("tier={authTier}"))
    // and the personal cards stay under the notice screen, as under every other dashboard
    const screen = page.slice(page.indexOf("if (showClosedNotice || showOffboardingNotice)"), at("tier={authTier}"))
    expect(screen).toContain("{personalCards}")
  })

  it("the card offers the chat only (no Request a Service) and uses its own texts", () => {
    expect(card).toContain("/portal/chat")
    expect(card).not.toContain("/portal/services/request")
    expect(card).toContain("offboardingCompany.title")
    expect(card).toContain("offboardingCompany.body")
    expect(card).toContain("offboardingCompany.chat")
  })

  it("the closed-company card is untouched", () => {
    const closed = read("app/portal/closed-company-card.tsx")
    expect(closed).toContain("closedCompany.title")
    expect(closed).toContain("/portal/services/request")
  })
})
