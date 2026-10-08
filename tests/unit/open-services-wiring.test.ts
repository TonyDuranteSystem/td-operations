import { describe, it, expect } from "vitest"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"

/**
 * N1a C3 — structural guarantees of the Open services page, pinned as source checks (the repo's unit tests run in plain
 * node: no browser rendering). Each rule below exists because a reviewer found a way for it to fail.
 */

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

const PAGE = "app/(dashboard)/calendar/open-services/page.tsx"

describe("the page", () => {
  const page = read(PAGE)
  const code = stripComments(page)

  it("is dynamic, so nothing is cached between requests", () => {
    expect(page).toContain("export const dynamic = 'force-dynamic'")
  })

  it("runs the guard FIRST, before anything is loaded, and a denied visitor gets notFound() outside the try block", () => {
    const guard = code.indexOf("requireOpenServicesAccess()")
    const notFound = code.indexOf("if (!access.ok) notFound()")
    const load = code.indexOf("loadOpenServicesInputs(")
    const tryAt = code.indexOf("try {")
    expect(guard).toBeGreaterThan(-1)
    expect(notFound).toBeGreaterThan(guard)
    expect(load).toBeGreaterThan(notFound)
    expect(tryAt).toBeGreaterThan(notFound)
  })

  it("passes the access proof to the loader and shows 'Could not load' instead of an empty list when a read fails", () => {
    expect(code).toContain("loadOpenServicesInputs(access)")
    expect(page).toContain("Could not load Open services.")
  })

  it("has its own loading and error screens (so the calendar's skeleton and error boundary are not involved)", () => {
    expect(existsSync(join(root, "app/(dashboard)/calendar/open-services/loading.tsx"))).toBe(true)
    expect(existsSync(join(root, "app/(dashboard)/calendar/open-services/error.tsx"))).toBe(true)
    expect(read("app/(dashboard)/calendar/open-services/error.tsx")).toContain("Nothing was changed")
  })
})

describe("the live calendar is untouched", () => {
  it("release 1 adds NO layout around /calendar (a layout is the one piece a switch cannot protect)", () => {
    expect(existsSync(join(root, "app/(dashboard)/calendar/layout.tsx"))).toBe(false)
  })

  it("nothing in the live calendar imports or mentions the new page", () => {
    const files = [
      "app/(dashboard)/calendar/page.tsx",
      ...readdirSync(join(root, "components/calendar")).map(f => `components/calendar/${f}`),
    ]
    for (const f of files) {
      expect(read(f), f).not.toMatch(/open-services|open_services/)
    }
  })
})

describe("client/server boundary", () => {
  it("the browser view imports only the pure shared files, never the builder, loader, guard or database", () => {
    const view = read("components/open-services/open-services-view.tsx")
    const imports = Array.from(view.matchAll(/from\s+['"]([^'"]+)['"]/g)).map(m => m[1])
    const mine = imports.filter(i => i.includes("open-services"))
    expect(mine.sort()).toEqual(["@/lib/open-services/params", "@/lib/open-services/types"].sort())
    expect(imports.join(" ")).not.toMatch(/supabase|lib\/services\/stages|settings/)
  })

  it("params.ts, types.ts and audience-shared.ts import nothing from the server side", () => {
    for (const f of ["params", "types", "audience-shared"]) {
      const src = read(`lib/open-services/${f}.ts`)
      const imports = Array.from(src.matchAll(/from\s+['"]([^'"]+)['"]/g)).map(m => m[1])
      for (const i of imports) expect(["@/lib/open-services/types"], `${f} imports ${i}`).toContain(i)
    }
  })

})

describe("no service name in the code", () => {
  const NAMES = [
    "Banking", "ITIN", "CMRA", "Tax Return", "State RA", "Annual Report", "Annual Renewal", "Company Formation",
    "Company Closure", "Client Onboarding", "EIN", "Consulting", "Notary", "Shipping", "TD Communication", "DBA",
  ]
  const files = readdirSync(join(root, "lib/open-services")).map(f => `lib/open-services/${f}`)
    .concat(["components/open-services/open-services-view.tsx", PAGE])
  for (const f of files) {
    it(`${f} names no service`, () => {
      const code = stripComments(read(f))
      for (const n of NAMES) expect(code, `${f} contains "${n}"`).not.toContain(n)
    })
  }
})

describe("the loader", () => {
  const load = read("lib/open-services/load.ts")
  const code = stripComments(load)

  it("demands the access proof and checks it at run time", () => {
    expect(code).toContain("access: OpenServicesAccessGranted")
    expect(code).toContain("access not granted")
  })

  it("throws on every read error instead of returning a partial list", () => {
    expect((code.match(/throw new Error\(/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it("builds the terminal-status filter from the repo's canonical list and reads by keyset, not offset", () => {
    expect(code).toContain("TERMINAL_DELIVERY_STATUSES.join(\",\")")
    expect(code).toContain(".gt(\"id\", after)")
    expect(code).not.toContain(".range(")
  })

  it("loads company and person details for EVERY open job, excluded ones too (their test/internal flags decide whether an excluded job is counted)", () => {
    expect(code).toContain("unique(jobs.map(j => j.account_id))")
    expect(code).toContain("unique(jobs.filter(j => !j.account_id).map(j => j.contact_id))")
    expect(code).not.toContain("kept")
  })

  it("refuses to run when the renewals exclusion card is missing", () => {
    expect(code).toContain("closes_only_by_filing was found")
  })

  it("refuses to run when the tax-return card has not been flagged yet (the migration must run before the switch goes on)", () => {
    expect(code).toContain("hidden_from_open_services was found")
    expect(code).toContain("run migration 20261007-0100-open-services-hidden-flag first")
  })
})

describe("the setting", () => {
  it("the guard module re-reads the setting on every request, fails closed, and never trusts isAdmin", () => {
    const access = stripComments(read("lib/open-services/access.ts"))
    expect(access).toContain("isOwnerOnly")
    expect(access).toContain("isStaffUser")
    expect(access).not.toContain("isAdmin")
    const audience = stripComments(read("lib/open-services/audience.ts"))
    expect(audience).toContain("parseAudience(")
    expect(audience).toMatch(/catch \(err\)[\s\S]*return "off"/)
    // read directly, so a real database error is logged (getAppSetting swallows it and it would look like "not found")
    expect(audience).toContain("if (error) throw new Error(error.message)")
    expect(audience).not.toContain("getAppSetting")
  })

})

describe("the search box", () => {
  const view = read("components/open-services/open-services-view.tsx")

  it("compares the CLEANED typed text with what was last SENT, not with the (lagging) address, so type-then-delete cannot desync", () => {
    expect(view).toContain("const cq = cleanQuery(q)")
    expect(view).toContain("if (cq === lastPushed.current) return")
    expect(view).not.toContain("if (q === params.q) return")
    expect(view).not.toContain("if (q === lastPushed.current) return")
  })

  it("never writes the visitor's own earlier searches back into the box (the server cleans spaces; a slower earlier answer can arrive late)", () => {
    expect(view).toContain("sent.current.has(params.q)")
    expect(view).toContain("sent.current.add(next.q)")
    expect(view).not.toContain("if (params.q !== lastPushed.current) {")
  })

  it("every control sends the typed text with its own change, so a click inside the search delay cannot be undone", () => {
    expect(view).toContain("function push(next: OpenServicesParams)")
    expect(view).toContain("go({ ...next, q: cq })")
    expect(/onClick=\{\(\) => go\(/.test(view)).toBe(false)
  })

  it("a group that hit the paging ceiling shows a plain note instead of a 'Show more' button that does nothing", () => {
    expect(view).toContain("g.hasMore && !g.capped")
    expect(view).toContain("g.capped &&")
  })

  it("never scrolls the page to the top when a control is used", () => {
    expect(view).toContain("{ scroll: false }")
  })
})
