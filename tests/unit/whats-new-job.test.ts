import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: vi.fn() } }))

import { WORKSPACE_SRC_TABLES, soleOpenJobId, srcTableOfRef } from "@/lib/notifications/whats-new-job"

const job = (id: string, status: string | null, is_test: boolean | null = false) => ({ id, status, is_test })

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

describe("srcTableOfRef and the records that belong to a company's own work", () => {
  it("reads the table half of the marker's source ref, tolerating junk", () => {
    expect(srcTableOfRef("ss4_applications:a706522b-d8ef-4567-9852-43e245b772ee")).toBe("ss4_applications")
    expect(srcTableOfRef("documents:abc")).toBe("documents")
    expect(srcTableOfRef(null)).toBe("")
    expect(srcTableOfRef(undefined)).toBe("")
    expect(srcTableOfRef("")).toBe("")
  })

  it("only the company's own work records go to a workspace; payments, onboarding, offers and tasks keep their own targets", () => {
    for (const t of ["ss4_applications", "documents", "lease_agreements"]) expect(WORKSPACE_SRC_TABLES.has(t), t).toBe(true)
    for (const t of ["payments", "onboarding_submissions", "offers", "tasks", "member_info_requests", ""]) expect(WORKSPACE_SRC_TABLES.has(t), t).toBe(false)
  })
})
