import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseParams, toQueryString, withTab } from "@/lib/new-calendar/params"

/** The pieces of "Invoices to raise" that are plain wiring (dev job ae3c19db): the tab, the blinking red counts, the menu badge, the builder wording. */
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8")

describe("the Calendar tab", () => {
  it("?tab=invoices opens it, and the address stays clean", () => {
    const p = parseParams({ tab: "invoices" })
    expect(p.tab).toBe("invoices")
    expect(toQueryString(p)).toBe("?tab=invoices")
    expect(withTab(p, "jobs").tab).toBe("jobs")
    expect(parseParams({ tab: "nonsense" }).tab).toBe("jobs")
  })
  it("is a tab with a red, BLINKING count when something is due (steady red for people who turned motion off)", () => {
    const src = read("components/new-calendar/new-calendar-view.tsx")
    expect(src).toContain("Invoices to raise <InvoicesCount invoices={invoices} />")
    expect(src).toContain("animate-pulse bg-red-600 text-white motion-reduce:animate-none")
    expect(src).toContain("<InvoicesToRaiseTab rows={invoices ? invoices.rows : null} />")
  })
  it("the page reads it on every tab, tolerant of a failed read (the Calendar still opens)", () => {
    const src = read("app/(dashboard)/new-calendar/page.tsx")
    expect(src).toContain("loadInvoicesToRaise(getOfficeDateString(now))")
    expect(src).toContain("area: 'new-calendar-invoices'")
    expect(src).toContain("invoices={invoices}")
  })
  it("the list: due rows red on top, coming up grey underneath, the payer named on every row, and a failed read is an error box, not 'nothing to raise'", () => {
    const src = read("components/plan-invoices/invoices-to-raise-tab.tsx")
    expect(src).toContain("Nothing is raised or emailed by itself")
    expect(src).toContain("Bill to:")
    expect(src).toContain("To raise now")
    expect(src).toContain("Coming up")
    expect(src).toContain("Could not load the invoices to raise.")
  })
  it("the button asks first (two steps), blinks when due, and shows the server's own words when it refuses", () => {
    const src = read("components/plan-invoices/raise-button.tsx")
    expect(src).toContain("Yes, raise and send")
    expect(src).toContain("animate-pulse motion-reduce:animate-none")
    expect(src).toContain("data.error ||")
    expect(src).toContain("/api/crm/admin-actions/raise-plan-part")
  })
  it("the Calendar's own components stay free of fetch: the writing piece lives in components/plan-invoices", () => {
    expect(read("components/new-calendar/new-calendar-view.tsx")).not.toContain("fetch(")
  })
})

describe("the red count on the left-menu Calendar item", () => {
  it("the badges route returns the number (and leaves it out when it could not be read)", () => {
    const src = read("app/api/dashboard/badges/route.ts")
    expect(src).toContain("countInvoicesDue(getOfficeDateString())")
    expect(src).toContain("...(invoicesToRaise !== null ? { invoicesToRaise } : {})")
  })
  it("the sidebar keeps it live and puts it on the Calendar item", () => {
    const src = read("components/dashboard/sidebar.tsx")
    expect(src).toContain("setLiveInvoices(data.invoicesToRaise)")
    expect(src).toContain("badge: liveInvoices > 0 ? liveInvoices : undefined")
  })
})

describe("the offer builder", () => {
  const src = read("components/offers/create-offer-dialog.tsx")
  it("offers 'When a step is reached' next to 'On a date' and 'When you say so'", () => {
    expect(src).toContain("When a step is reached")
    expect(src).toContain("On a date")
    expect(src).toContain("When you say so")
    expect(src).toContain("/api/crm/offer-plan-steps?services=")
  })
  it("says what is true: nothing is raised by itself", () => {
    expect(src).toContain("Nothing else is ever raised or")
    expect(src).not.toContain("Every later part is raised")
  })
  it("a step part carries the service, the step and the client's words into the plan", () => {
    expect(src).toContain("service_type: p.service_type ?? '', stage: p.stage ?? ''")
    expect(src).toContain("(p.kind === 'manual' || p.kind === 'step')")
  })
})

describe("the steps route", () => {
  it("is staff only, read-only, and under /api/crm (not the public /api/offers)", () => {
    const src = read("app/api/crm/offer-plan-steps/route.ts")
    expect(src).toContain("isStaffUser(user)")
    expect(src).not.toContain(".insert(")
    expect(src).not.toContain(".update(")
  })
})

describe("found by the end-to-end QA run (browser + bug hunter)", () => {
  it("the Raise button ignores a very fast second click, warns before billing a part that is not due, and tells the menu to refresh", () => {
    const src = read("components/plan-invoices/raise-button.tsx")
    expect(src).toContain("if (inFlight.current) return")
    expect(src).toContain("This part is not due yet")
    expect(src).toContain("td:invoices-to-raise-changed")
    expect(read("components/dashboard/sidebar.tsx")).toContain("td:invoices-to-raise-changed")
  })
  it("the row passes its own words to the button as the not-due warning, only for rows that are not due", () => {
    expect(read("components/plan-invoices/invoices-to-raise-tab.tsx")).toContain("notDueText={r.due ? undefined : r.text}")
  })
  it("both new routes accept staff only (not just 'anyone who is not a client')", () => {
    expect(read("app/api/crm/offer-plan-steps/route.ts")).toContain("isStaffUser(user)")
    expect(read("app/api/crm/admin-actions/raise-plan-part/route.ts")).toContain("isStaffUser(user)")
  })
  it("an invoice sent to a person with no company names the person on the PDF, not 'Client'", () => {
    const src = read("lib/invoice-auto-send.ts")
    expect(src.match(/account\?\.company_name \?\? \(recipientName \|\| "Client"\)/g)?.length).toBe(2)
    expect(src).not.toMatch(/name: account\?\.company_name \?\? "Client"/)
  })
})
