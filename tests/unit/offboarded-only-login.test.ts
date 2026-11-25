/**
 * An offboarded client who NEVER set a password sees the offboarded message and nothing else (dev job 31dfd3a6, Antonio 25 Nov 2026).
 * The PasswordGate used to send such a login to "Set Your Password" on every portal page, so the notice flashed and vanished.
 * lib/portal/offboarded-only-login.ts is the one rule; the portal layout draws the bare screen from it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const state = vi.hoisted(() => ({
  links: [] as Array<{ account_id: string }>,
  accounts: [] as Array<{ id: string; company_name: string; status: string }>,
  offers: [] as Array<{ status: string; client_email?: string; lead_id?: string; created_at: string }>,
  leads: [] as Array<{ id: string; email: string }>,
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
}))

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const filters: Array<[string, string, unknown]> = []
    const b: Record<string, unknown> = {}
    const rec = (op: string) => (...args: unknown[]) => {
      state.calls.push({ table, op, args })
      filters.push([op, String(args[0]), args[1]])
      return b
    }
    for (const op of ["select", "is", "eq", "in", "order", "not", "limit"]) b[op] = rec(op)
    const find = (op: string, col: string) => filters.find((f) => f[0] === op && f[1] === col)?.[2]
    const rows = (): unknown[] => {
      if (table === "account_contacts") return state.links
      if (table === "accounts") {
        const s = find("eq", "status")
        return state.accounts.filter((a) => a.status === s).sort((x, y) => x.company_name.localeCompare(y.company_name))
      }
      if (table === "offers") {
        let r = state.offers.filter((o) => o.status !== "expired")
        const em = find("in", "client_email") as string[] | undefined
        if (em) r = r.filter((o) => em.includes(o.client_email ?? ""))
        const lid = find("eq", "lead_id")
        if (lid) r = r.filter((o) => o.lead_id === lid)
        return r.sort((x, y) => y.created_at.localeCompare(x.created_at))
      }
      if (table === "leads") {
        const em = find("in", "email") as string[] | undefined
        return state.leads.filter((l) => (em ?? []).includes(l.email))
      }
      return []
    }
    b.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null })
    b.then = (resolve: (v: { data: unknown }) => void) => resolve({ data: rows() })
    return b
  }
  return { supabaseAdmin: { from: (t: string) => { state.calls.push({ table: t, op: "from", args: [] }); return builder(t) } } }
})

import { isOffboardedOnlyLogin, resolveOffboardedOnlyScreen, getLatestOfferStatusForLogin } from "@/lib/portal/offboarded-only-login"
import { showOffboardingCompanyNotice } from "@/lib/portal/closed-company"
import { t } from "@/lib/portal/i18n"

const ROOT = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

const base = {
  mustChangePassword: true,
  visibleCompanyCount: 0,
  inProgressCount: 0,
  authTier: "lead",
  isPartnerOrDual: false,
  closedCompanyCount: 0,
  offboardingCompanyCount: 1,
  offerStatus: null as string | null,
}

describe("isOffboardedOnlyLogin (the pure rule)", () => {
  it("applies to a never-set-password login whose companies are all offboarding", () => {
    expect(isOffboardedOnlyLogin(base)).toBe(true)
    expect(isOffboardedOnlyLogin({ ...base, offerStatus: "completed" })).toBe(true)
    expect(isOffboardedOnlyLogin({ ...base, offboardingCompanyCount: 2 })).toBe(true)
  })

  it("never applies once the password is set (that client keeps the normal home page with the Chat button)", () => {
    expect(isOffboardedOnlyLogin({ ...base, mustChangePassword: false })).toBe(false)
  })

  it("never applies when the client still has a visible company, or something being formed / onboarded", () => {
    expect(isOffboardedOnlyLogin({ ...base, visibleCompanyCount: 1 })).toBe(false)
    expect(isOffboardedOnlyLogin({ ...base, inProgressCount: 1 })).toBe(false)
  })

  it("never applies to a formation-tier login or a partner / client+partner login", () => {
    expect(isOffboardedOnlyLogin({ ...base, authTier: "formation" })).toBe(false)
    expect(isOffboardedOnlyLogin({ ...base, isPartnerOrDual: true })).toBe(false)
  })

  it("never applies when a company is CLOSED (that notice keeps its own screen) or nothing is offboarding", () => {
    expect(isOffboardedOnlyLogin({ ...base, closedCompanyCount: 1 })).toBe(false)
    expect(isOffboardedOnlyLogin({ ...base, offboardingCompanyCount: 0 })).toBe(false)
  })

  it("never applies while a NEW offer is being sold (the welcome flow, with its password step, is right then)", () => {
    for (const s of ["draft", "sent", "viewed", "signed"]) expect(isOffboardedOnlyLogin({ ...base, offerStatus: s }), s).toBe(false)
  })

  it("uses the home page's own notice rule for the offer part (no second copy of it)", () => {
    for (const s of [null, undefined, "", "completed", "draft", "sent", "viewed", "signed"]) {
      for (const n of [0, 1, 2]) {
        expect(isOffboardedOnlyLogin({ ...base, offboardingCompanyCount: n, offerStatus: s })).toBe(showOffboardingCompanyNotice({ offboardingCompanyCount: n, offerStatus: s }))
      }
    }
  })
})

describe("resolveOffboardedOnlyScreen (server side)", () => {
  const args = {
    email: "client@example.com",
    contactId: "c1",
    mustChangePassword: true,
    visibleCompanyCount: 0,
    inProgressCount: 0,
    authTier: "lead",
    isPartnerOrDual: false,
  }
  beforeEach(() => {
    state.calls.length = 0
    state.links = [{ account_id: "a1" }, { account_id: "a2" }]
    state.accounts = [
      { id: "a1", company_name: "Zeta LLC", status: "Offboarding" },
      { id: "a2", company_name: "Alpha LLC", status: "Offboarding" },
    ]
    state.offers = []
    state.leads = []
  })

  it("returns the offboarded company names, in name order", async () => {
    expect(await resolveOffboardedOnlyScreen(args)).toEqual({ companyNames: ["Alpha LLC", "Zeta LLC"] })
  })

  it("asks nothing from the database for everyone it cannot apply to (a login that set its password, or has a company)", async () => {
    for (const patch of [{ mustChangePassword: false }, { visibleCompanyCount: 1 }, { inProgressCount: 2 }, { authTier: "formation" }, { isPartnerOrDual: true }, { contactId: null }]) {
      state.calls.length = 0
      expect(await resolveOffboardedOnlyScreen({ ...args, ...patch }), JSON.stringify(patch)).toBeNull()
      expect(state.calls.length, JSON.stringify(patch)).toBe(0)
    }
  })

  it("returns null when a company is also closed", async () => {
    state.accounts.push({ id: "a3", company_name: "Beta LLC", status: "Closed" })
    state.links.push({ account_id: "a3" })
    expect(await resolveOffboardedOnlyScreen(args)).toBeNull()
  })

  it("returns null while a new offer is out, and applies once the latest offer is completed", async () => {
    state.offers = [{ status: "sent", client_email: "client@example.com", created_at: "2026-11-20" }]
    expect(await resolveOffboardedOnlyScreen(args)).toBeNull()
    state.offers = [{ status: "completed", client_email: "client@example.com", created_at: "2026-11-24" }, { status: "sent", client_email: "client@example.com", created_at: "2026-11-01" }]
    expect(await resolveOffboardedOnlyScreen(args)).toEqual({ companyNames: ["Alpha LLC", "Zeta LLC"] })
  })

  it("an expired offer does not count", async () => {
    state.offers = [{ status: "expired", client_email: "client@example.com", created_at: "2026-11-20" }]
    expect(await resolveOffboardedOnlyScreen(args)).toEqual({ companyNames: ["Alpha LLC", "Zeta LLC"] })
  })
})

describe("getLatestOfferStatusForLogin (finds the offer the way the home page does)", () => {
  beforeEach(() => {
    state.calls.length = 0
    state.offers = []
    state.leads = []
  })

  it("by the login's email, newest first, expired left out", async () => {
    state.offers = [
      { status: "viewed", client_email: "a@x.com", created_at: "2026-11-02" },
      { status: "signed", client_email: "a@x.com", created_at: "2026-11-09" },
      { status: "expired", client_email: "a@x.com", created_at: "2026-11-20" },
    ]
    expect(await getLatestOfferStatusForLogin("a@x.com")).toBe("signed")
    expect(state.calls.some((c) => c.table === "offers" && c.op === "not" && c.args[0] === "status" && c.args[1] === "eq" && c.args[2] === "expired")).toBe(true)
  })

  it("falls back to the offer of the lead with that email", async () => {
    state.leads = [{ id: "L1", email: "a@x.com" }]
    state.offers = [{ status: "sent", lead_id: "L1", created_at: "2026-11-09" }]
    expect(await getLatestOfferStatusForLogin("a@x.com")).toBe("sent")
  })

  it("no email, or no offer at all, means no status", async () => {
    expect(await getLatestOfferStatusForLogin(null)).toBeNull()
    expect(await getLatestOfferStatusForLogin("nobody@x.com")).toBeNull()
  })
})

describe("the portal layout draws the bare screen from that rule", () => {
  const layout = read("app/portal/layout.tsx")
  const card = read("app/portal/offboarding-company-card.tsx")
  const page = read("app/portal/page.tsx")
  const stopAt = layout.indexOf("if (offboardedOnly) {")
  const nextAt = layout.indexOf("// Account-level data: only if an account is selected")

  it("asks the shared resolver, with the real inputs, in the client branch", () => {
    expect(layout).toContain("resolveOffboardedOnlyScreen({")
    for (const part of ["email: user.email", "contactId,", "mustChangePassword,", "visibleCompanyCount: accounts.length", "inProgressCount: inProgress.length + inProgressOnboardings.length", "isPartnerOrDual: portalModeCtx.dual || portalModeCtx.mode === 'partner' || effectivePortalRole === 'partner'"]) {
      expect(layout, part).toContain(part)
    }
  })

  it("decides before the per-company queries, and the bare screen has no password gate, no menu and no other page", () => {
    expect(stopAt).toBeGreaterThan(-1)
    expect(stopAt).toBeLessThan(nextAt)
    const bare = layout.slice(stopAt, nextAt)
    expect(bare).toContain("<OffboardingCompanyCard companyNames={offboardedOnly.companyNames} stop />")
    expect(bare).not.toContain("PasswordGate")
    expect(bare).not.toContain("PortalSidebar")
    expect(bare).not.toContain("{children}")
    expect(bare).toContain("ViewAsBanner") // staff still see they are viewing as the client, with Exit
  })

  it("the normal client screen still has the password gate", () => {
    expect(layout).toContain("<PasswordGate mustChangePassword={mustChangePassword} />")
  })

  it("the card's stop variant has no Chat button and uses the support-address text; the normal variant is unchanged", () => {
    expect(card).toContain("stop = false")
    expect(card).toContain("offboardingCompany.stopBody")
    expect(card).toMatch(/\{!stop && \(\s*<div[\s\S]*\/portal\/chat/)
    expect(card).toContain("offboardingCompany.chat")
  })

  it("texts exist in English and Italian, name the support address, and promise no chat", () => {
    for (const locale of ["en", "it"] as const) {
      const body = t("offboardingCompany.stopBody", locale)
      expect(body, locale).not.toBe("offboardingCompany.stopBody")
      expect(body).toContain("{company}")
      expect(body).toContain("support@tonydurante.us")
      expect(body.toLowerCase()).not.toMatch(/chat/)
    }
    expect(t("offboardingCompany.stopBody", "it")).not.toBe(t("offboardingCompany.stopBody", "en"))
  })

  it("finds the offer the same way the home page does (same expired filter and lead fallback), so the two cannot drift", () => {
    const helper = read("lib/portal/offboarded-only-login.ts")
    expect(page).toContain(".not('status', 'eq', 'expired')")
    expect(helper).toContain(".not('status', 'eq', 'expired')")
    expect(page).toContain(".from('leads')")
    expect(helper).toContain(".from('leads')")
    expect(helper).toContain("showOffboardingCompanyNotice(")
  })
})
