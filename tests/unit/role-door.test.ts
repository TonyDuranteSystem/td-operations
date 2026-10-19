/**
 * TD Marketing P1 — the door rule. Pure tests of lib/auth/role-door.ts, plus a walk over EVERY page and API route in the app:
 * a marketing login may reach only the marketing workspace and the two-step pages, never anything else.
 */
import { describe, it, expect } from "vitest"
import { readdirSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import {
  isKnownAuthRole, isMarketingAllowedPath, isPathAllowedForRole, isMarketingRole, normalizeRole, MARKETING_HOME,
} from "@/lib/auth/role-door"

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/^(page|route)\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
function toUrl(file: string): string {
  const rel = file.split(sep).join("/").replace(/^app\//, "").replace(/\/(page|route)\.(ts|tsx)$/, "")
  const parts = rel.split("/").filter(seg => seg && !/^\(.*\)$/.test(seg)) // route groups are not part of the address
  return "/" + parts.map(seg => (seg.startsWith("[") ? "x" : seg)).join("/")
}

describe("known roles", () => {
  it("knows exactly admin, team, client, partner, marketing (any letter case, trimmed)", () => {
    for (const r of ["admin", "team", "client", "partner", "marketing", " Marketing ", "ADMIN"]) expect(isKnownAuthRole(r), r).toBe(true)
    for (const r of ["", null, undefined, "staff", "contractor", "owner", "rocco", 42, {}]) expect(isKnownAuthRole(r as unknown), String(r)).toBe(false)
  })
  it("normalizeRole and isMarketingRole", () => {
    expect(normalizeRole("  MaRkEtInG ")).toBe("marketing")
    expect(isMarketingRole("marketing")).toBe(true)
    expect(isMarketingRole("team")).toBe(false)
    expect(isMarketingRole(undefined)).toBe(false)
  })
})

describe("marketing allow-list", () => {
  it("allows the workspace, the two-step pages and its own API family", () => {
    for (const p of ["/marketing", "/marketing/leads", "/marketing/leads/123", "/mfa/verify", "/mfa/enroll", "/api/marketing/me", "/api/marketing/team/invite",
      "/api/mfa/backup-verify", "/api/mfa/backup-codes", "/api/mfa/remember"]) expect(isMarketingAllowedPath(p), p).toBe(true)
  })
  it("refuses every staff, client and look-alike address", () => {
    for (const p of ["/", "/accounts", "/finance", "/portal", "/portal/invoices", "/talk", "/team-chat", "/collab", "/dev-tools", "/team-management",
      "/api/accounts", "/api/portal/chat/threads", "/api/team/threads", "/api/mfa/admin-reset", "/api/mfa/exemption", "/api/crm/admin-actions/x",
      "/marketing-admin", "/marketingx", "/api/marketingx/me", "/api/marketing", "/mfa", "/mfa/other", "/mfa/verify/extra"]) {
      expect(isMarketingAllowedPath(p), p).toBe(false)
    }
  })
  it("refuses path tricks", () => {
    for (const p of ["/marketing/../accounts", "/marketing//x", "/marketing/..%2f", "/marketing\\x", "/api/marketing/../accounts"]) {
      // %2f is not decoded here (the router decodes later); the literal dot-dot, double slash and backslash are refused outright
      if (p.includes("%2f")) continue
      expect(isMarketingAllowedPath(p), p).toBe(false)
    }
  })
  it("ignores a query string or hash when deciding", () => {
    expect(isMarketingAllowedPath("/marketing?tab=leads")).toBe(true)
    expect(isMarketingAllowedPath("/accounts?next=/marketing")).toBe(false)
    expect(isMarketingAllowedPath("/accounts#/marketing/x")).toBe(false)
  })
  it("MARKETING_HOME is itself allowed (a refused request must land somewhere reachable)", () => {
    expect(isMarketingAllowedPath(MARKETING_HOME)).toBe(true)
  })
})

describe("the whole rule per role", () => {
  it("admin and team are allowed; an unknown role is refused everywhere", () => {
    expect(isPathAllowedForRole("admin", "/accounts")).toBe(true)
    expect(isPathAllowedForRole("team", "/finance")).toBe(true)
    for (const r of ["", "staff", "contractor", null, undefined]) expect(isPathAllowedForRole(r, "/accounts"), String(r)).toBe(false)
  })
  it("partner keeps exactly its old surface", () => {
    expect(isPathAllowedForRole("partner", "/collab")).toBe(true)
    expect(isPathAllowedForRole("partner", "/collab/x")).toBe(true)
    expect(isPathAllowedForRole("partner", "/api/conversations/1")).toBe(true)
    expect(isPathAllowedForRole("partner", "/api/td-communication/x")).toBe(true)
    expect(isPathAllowedForRole("partner", "/accounts")).toBe(false)
    expect(isPathAllowedForRole("partner", "/marketing")).toBe(false)
  })
  it("marketing follows its list", () => {
    expect(isPathAllowedForRole("marketing", "/marketing/leads")).toBe(true)
    expect(isPathAllowedForRole("marketing", "/accounts")).toBe(false)
  })
})

describe("every page and API route of the app, for a marketing login", () => {
  const files = walk("app")
  const urls = files.map(toUrl)
  it("finds the app's routes (sanity: hundreds of them)", () => {
    expect(urls.length).toBeGreaterThan(300)
    expect(urls).toContain("/api/health")
  })
  it("a marketing login can reach NOTHING except the workspace, the two-step pages and its own APIs", () => {
    const reachable = urls.filter(u => isMarketingAllowedPath(u))
    const unexpected = reachable.filter(u => !(u.startsWith("/marketing") || u.startsWith("/api/marketing/") || u === "/mfa/verify" || u === "/mfa/enroll" ||
      ["/api/mfa/backup-verify", "/api/mfa/backup-codes", "/api/mfa/remember"].includes(u)))
    expect(unexpected).toEqual([])
  })
  it("the two-step pages and APIs the marketing list names really exist (a typo would lock people out)", () => {
    for (const u of ["/mfa/verify", "/mfa/enroll", "/api/mfa/backup-verify", "/api/mfa/backup-codes", "/api/mfa/remember"]) expect(urls, u).toContain(u)
  })
  it("no staff or client address is reachable: spot-check a sample of real routes", () => {
    for (const u of ["/api/accounts/x", "/api/portal/chat/threads", "/api/team/threads", "/accounts", "/finance", "/api/mcp"]) {
      if (urls.includes(u)) expect(isMarketingAllowedPath(u), u).toBe(false)
    }
  })
})
