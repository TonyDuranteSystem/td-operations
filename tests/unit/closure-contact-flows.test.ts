import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * The closure workspace must be reachable from the CRM contact page (dev job 9829a468 — Contrabona, 2026-11-11):
 * a Company Closure on a PERSON has no company page, so before this the contact page showed it only as a row in a
 * table, with no link to the workspace (the client's answers and documents). The Flows strip and a banner now carry it.
 */

let sdRows: Array<Record<string, unknown>> = []
let accountRows: Array<Record<string, unknown>> = []
let wizardRows: Array<Record<string, unknown>> = []
let wizardThrows = false

vi.mock("@/lib/supabase-admin", () => {
  const make = (table: string) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.neq = () => c
    c.in = () => c
    c.order = () => c
    c.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) => {
      if (table === "wizard_progress" && wizardThrows) return rej ? rej(new Error("boom")) : undefined
      const data = table === "service_deliveries" ? sdRows : table === "accounts" ? accountRows : table === "wizard_progress" ? wizardRows : []
      return res({ data, error: null })
    }
    return c
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

import { resolveFlowsByContact, closureUnitLabel, STAFF_CONTACT_FLOW_TYPES, CONTACT_FLOW_TYPES } from "@/lib/flows/resolve-flows"

const sd = (over: Record<string, unknown>) => ({
  id: "sd", service_type: "Company Closure", service_name: "Company Closure - X", stage: "Data Collection", stage_order: 1,
  status: "active", due_date: null, stage_entered_at: "2026-11-11T10:00:00Z", created_at: "2026-11-11T09:00:00Z", account_id: null, ...over,
})

describe("closureUnitLabel", () => {
  it("reads the unit number from the job name", () => {
    expect(closureUnitLabel("Company Closure - Gabriel Contra #2")).toBe("#2")
    expect(closureUnitLabel("Company Closure - X #10 ")).toBe("#10")
  })
  it("no unit number → null (a single closure keeps its plain name)", () => {
    expect(closureUnitLabel("Company Closure - Gabriel Contra")).toBeNull()
    expect(closureUnitLabel("Company #3 Closure")).toBeNull()
    expect(closureUnitLabel(null)).toBeNull()
    expect(closureUnitLabel(undefined)).toBeNull()
  })
})

describe("resolveFlowsByContact — closure jobs on a person", () => {
  beforeEach(() => { sdRows = []; accountRows = []; wizardRows = []; wizardThrows = false })

  it("returns BOTH closure jobs of a contract that closes two companies, each with its own workspace id", async () => {
    sdRows = [sd({ id: "a", service_name: "Company Closure - X #1" }), sd({ id: "b", service_name: "Company Closure - X #2" })]
    const flows = await resolveFlowsByContact("c1")
    expect(flows.map((f) => f.service_delivery_id)).toEqual(["a", "b"])
    expect(flows.every((f) => f.flow_type === "Company Closure" && f.status === "active")).toBe(true)
    expect(flows.map((f) => f.unit_label)).toEqual(["#1", "#2"])
  })

  it("names a closure by the company the client wrote in the form (person-level job)", async () => {
    sdRows = [sd({ id: "a" }), sd({ id: "b", service_name: "Company Closure - X #2" })]
    wizardRows = [{ service_delivery_id: "a", data: { llc_name: "  LLC Novag LLC " } }]
    const flows = await resolveFlowsByContact("c1")
    expect(flows.find((f) => f.service_delivery_id === "a")?.company_name).toBe("LLC Novag LLC")
    expect(flows.find((f) => f.service_delivery_id === "b")?.company_name).toBeNull()
  })

  it("names a closure of a company of ours by the CRM company", async () => {
    sdRows = [sd({ id: "a", account_id: "acct-1" })]
    accountRows = [{ id: "acct-1", company_name: "Acme LLC" }]
    const flows = await resolveFlowsByContact("c1")
    expect(flows[0].company_name).toBe("Acme LLC")
  })

  it("a failed name lookup only means no name — the chip is still there", async () => {
    sdRows = [sd({ id: "a" })]
    wizardThrows = true
    const flows = await resolveFlowsByContact("c1")
    expect(flows).toHaveLength(1)
    expect(flows[0].company_name).toBeNull()
  })

  it("other flow types are unchanged: no company name, no unit label", async () => {
    sdRows = [sd({ id: "i", service_type: "ITIN", service_name: "ITIN - X #2" })]
    const flows = await resolveFlowsByContact("c1")
    expect(flows[0]).toMatchObject({ flow_type: "ITIN", company_name: null, unit_label: null })
  })
})

describe("the closure flow is staff-only", () => {
  it("is NOT in the list the client portal reads (Service Status, flow page gate, journey layout)", () => {
    expect((CONTACT_FLOW_TYPES as readonly string[]).includes("Company Closure")).toBe(false)
    expect((STAFF_CONTACT_FLOW_TYPES as readonly string[]).includes("Company Closure")).toBe(true)
  })
  it("the contact page draws one banner per active closure job and passes the company and the unit", () => {
    const src = readFileSync(join(process.cwd(), "app/(dashboard)/contacts/[id]/page.tsx"), "utf8")
    expect(src).toContain("contactFlows.filter(")
    expect(src).toContain("f.flow_type === 'Company Closure' && f.status === 'active' && f.service_delivery_id")
    expect(src).toContain("<ClosureWorkspaceBanner")
    expect(src).toContain("unitLabel={f.unit_label}")
  })
  it("the Flows strip has an icon for it (the icon map is a Record over every flow type)", () => {
    expect(readFileSync(join(process.cwd(), "components/flows/flow-chips.tsx"), "utf8")).toContain("'Company Closure': DoorClosed")
  })
})
