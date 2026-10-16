import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: vi.fn() } }))

import { WORKSPACE_SRC_TABLES, soleOpenJobId, srcTableOfRef } from "@/lib/notifications/whats-new-job"

const job = (id: string, status: string | null, is_test: boolean | null = false, service_type = "Company Formation", entry: string | null = null) => ({
  id, status, is_test, service_type, service_type_entry_id: entry,
})
const RENEWAL_CARD = { id: "card-renew", display_name: "State RA Renewal", metadata: { closes_only_by_filing: true, delivery_service_type: "State RA Renewal" } }
const TAX_CARD = { id: "card-tax", display_name: "Tax Return", metadata: { hidden_from_open_services: "true", delivery_service_type: "Tax Return" } }

describe("soleOpenJobId: the workspace a What's New note can open straight away", () => {
  it("one open job is THE job (an 'active' or empty status counts as open)", () => {
    expect(soleOpenJobId([job("j1", "active")])).toBe("j1")
    expect(soleOpenJobId([job("j1", null)])).toBe("j1")
    expect(soleOpenJobId([job("j1", "Active")])).toBe("j1")
  })

  it("two or more open jobs is ambiguous: none (the client page stays the target)", () => {
    expect(soleOpenJobId([job("j1", "active"), job("j2", "active")])).toBeNull()
  })

  it("finished, cancelled and test jobs are not counted; a company with no open job gets none", () => {
    expect(soleOpenJobId([job("j1", "active"), job("j2", "completed"), job("j3", "cancelled"), job("j4", "active", true)])).toBe("j1")
    expect(soleOpenJobId([job("j2", "completed")])).toBeNull()
    expect(soleOpenJobId([])).toBeNull()
  })
})

describe("soleOpenJobId counts what the CALENDAR counts: renewals and tax returns live on other pages", () => {
  it("a renewal or tax-return job is not the 'only open job' (the button would open a job the Calendar does not even list)", () => {
    const jobs = [job("j-renew", "active", false, "State RA Renewal", "card-renew")]
    expect(soleOpenJobId(jobs, [RENEWAL_CARD, TAX_CARD])).toBeNull()
    expect(soleOpenJobId([job("j-tax", "active", false, "Tax Return")], [RENEWAL_CARD, TAX_CARD])).toBeNull()
  })

  it("a real job next to a renewal is still THE job; two real jobs are still ambiguous", () => {
    expect(soleOpenJobId([job("j1", "active"), job("j-renew", "active", false, "State RA Renewal", "card-renew")], [RENEWAL_CARD])).toBe("j1")
    expect(soleOpenJobId([job("j1", "active"), job("j2", "active", false, "ITIN")], [RENEWAL_CARD])).toBeNull()
  })
})

describe("srcTableOfRef and the records that belong to a company's own work", () => {
  it("reads the table half of the marker's source ref, tolerating junk", () => {
    expect(srcTableOfRef("ss4_applications:a706522b-d8ef-4567-9852-43e245b772ee")).toBe("ss4_applications")
    expect(srcTableOfRef("documents:abc")).toBe("documents")
    expect(srcTableOfRef(null)).toBe("")
    expect(srcTableOfRef(undefined)).toBe("")
    expect(srcTableOfRef("")).toBe("")
  })

  it("only the company's own work records go to a workspace; payments, onboarding, offers and tasks keep their own targets", () => {
    for (const t of ["ss4_applications", "documents"]) expect(WORKSPACE_SRC_TABLES.has(t), t).toBe(true)
    // a lease belongs to the company, not to one job
    for (const t of ["lease_agreements", "payments", "onboarding_submissions", "offers", "tasks", "member_info_requests", ""]) expect(WORKSPACE_SRC_TABLES.has(t), t).toBe(false)
  })
})
