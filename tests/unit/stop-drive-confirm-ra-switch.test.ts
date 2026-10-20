/**
 * Stop Drive, slice S1c (dev job 264bb882): confirming the Registered Agent switch files the receipt in the company's
 * STORAGE (never Drive, no Drive folder is created), and a company with no storage is told so in one plain sentence — the
 * switch itself still goes through (it was done by hand) and the receipt stays safe in the upload area.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ACCOUNT_OLD_FOLDER } from "./_stop-drive-mocks"
import { NO_STORAGE_REASON_SENTENCE } from "@/lib/crm-store/no-storage"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveCalls: [] as string[],
  route: "store" as "store" | "drive",
  saves: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  moving: false,
  uploaded: [] as string[],
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never, { removed: state.removed }) }
})
vi.mock("@/lib/google-drive", async () => {
  const h = await import("./_stop-drive-mocks")
  return h.driveSpyDynamic(state.driveCalls, () => (state.route === "drive" && state.rows.accounts && (state.rows.accounts as { drive_folder_id?: string }).drive_folder_id ? "record" : "forbid"))
})
vi.mock("@/lib/crm-store/switched-drive-guard", () => ({ companyDocState: async () => (state.moving ? "moving" : state.route === "store" ? "store" : "drive") }))
vi.mock("@/lib/drive-folder-utils", () => ({ ensureCompanyFolder: vi.fn(async () => { state.driveCalls.push("ensureCompanyFolder"); throw new Error("no") }) }))
vi.mock("@/lib/auth/require-staff-route", () => ({ requireStaffRoute: async () => null }))
vi.mock("@/lib/operations/service-delivery", () => ({ advanceStageIfAt: async () => ({ advanced: true }) }))
vi.mock("@/lib/operations/renewal-dates", () => ({ deriveRenewalDates: () => ({}), applyRenewalDateFills: async () => [] }))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  CompanyMovingError: class extends Error {},
  saveDocumentForAccount: vi.fn(async (input: Record<string, unknown>) => {
    state.saves.push(input)
    return state.route === "store" ? { route: "store", fileId: "f-1", pointer: "store:f-1", documentRowId: "doc-1", status: "created" } : { route: "drive" }
  }),
}))

const req = () => {
  const f = new FormData()
  f.set("receipt", new File(["receipt"], "receipt.png", { type: "image/png" }))
  return new NextRequest("http://localhost/x", { method: "POST", body: f })
}

beforeEach(() => {
  state.route = "store"
  state.moving = false
  state.recorded.length = 0
  state.driveCalls.length = 0
  state.saves.length = 0
  for (const k of Object.keys(state.rows)) delete state.rows[k]
  state.rows.onboarding_submissions = { id: "sub-1", account_id: "acct-1", reviewed_at: "2026-10-01T00:00:00Z" }
  state.rows.service_deliveries = { id: "sd-1", stage: "RA Switch" }
  state.rows.pipeline_stages = { stage_name: "Complete" }
  state.rows.accounts = { company_name: "Acme LLC", state_of_formation: "WY", formation_date: null, ra_switch_date: null, client_since: null }
})

describe("confirm-ra-switch", () => {
  it("storage company: the receipt is filed in 1. Company (internal), no Drive folder is created, zero Drive calls", async () => {
    const { POST } = await import("@/app/api/onboarding-review/[id]/confirm-ra-switch/route")
    const res = await POST(req(), { params: { id: "sub-1" } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.message).toContain("filed in the company's CRM storage")
    expect(state.saves[0]).toMatchObject({ accountId: "acct-1", folder: "company", portalVisible: false })
    expect(state.saves[0].row).toMatchObject({ document_type_name: "RA Switch Receipt" })
    expect(state.driveCalls).toEqual([])
  })

  it("a company that can receive no file (no storage, no folder): refused up front with the one sentence — nothing saved, the stage NOT moved, zero Drive calls", async () => {
    state.route = "drive"
    state.rows.accounts = { ...(state.rows.accounts as object), ...{ status: "Closed", drive_folder_id: "F-old", gdrive_folder_url: null } }
    const { POST } = await import("@/app/api/onboarding-review/[id]/confirm-ra-switch/route")
    const res = await POST(req(), { params: { id: "sub-1" } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: NO_STORAGE_REASON_SENTENCE.archived })
    expect(state.saves).toEqual([])
    expect(state.driveCalls).toEqual([])
    // nothing was stored (no durable copy was made for a refused confirmation)
    expect(state.recorded.filter((r) => r.table === "service_deliveries")).toEqual([])
  })

  it("a company left on its old folder is frozen (Stop Drive S2): refused up front with the true sentence, zero Drive calls, stage not moved", async () => {
    state.route = "drive"
    state.rows.accounts = { ...(state.rows.accounts as object), ...ACCOUNT_OLD_FOLDER }
    const { POST } = await import("@/app/api/onboarding-review/[id]/confirm-ra-switch/route")
    const res = await POST(req(), { params: { id: "sub-1" } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: NO_STORAGE_REASON_SENTENCE.frozen })
    expect(state.driveCalls).toEqual([])
    expect(state.recorded.filter((r) => r.table === "service_deliveries")).toEqual([])
  })

  it("a company being MOVED: refused up front with 'try again' — nothing saved, the stage not moved, no staged copy made", async () => {
    state.moving = true
    const { POST } = await import("@/app/api/onboarding-review/[id]/confirm-ra-switch/route")
    const res = await POST(req(), { params: { id: "sub-1" } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("try again in a few minutes")
    expect(state.saves).toEqual([])
    expect(state.recorded.filter((r) => r.table === "service_deliveries")).toEqual([])
  })
})
