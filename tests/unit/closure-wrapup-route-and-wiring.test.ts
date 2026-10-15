/**
 * Company Closure "Wrap-up" panel — the staff-only route and the wiring (slice 1, dev job 5b136702).
 *
 * Covers: the route refuses non-staff BEFORE reading anything; it hands the loader's own error and status back; the new stage
 * component is registered where the workspace renders it; the browser panel cannot pull in server-only code and cannot write;
 * the panel migration only touches the Wrap-up step and has an UNDO.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NextResponse } from "next/server"

const requireStaffRoute = vi.fn()
vi.mock("@/lib/auth/require-staff-route", () => ({ requireStaffRoute: () => requireStaffRoute() }))

const loadWrapUpFacts = vi.fn()
vi.mock("@/lib/closure/wrapup-facts-load", () => ({ loadWrapUpFacts: (...a: unknown[]) => loadWrapUpFacts(...a) }))

import { GET } from "@/app/api/flows/[id]/wrapup-facts/route"
import { parseStageLayout, STAGE_COMPONENT_TYPES } from "@/lib/flows/stage-layout"

const ROOT = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const ctx = { params: { id: "job-1" } }
const req = {} as never

beforeEach(() => {
  requireStaffRoute.mockReset()
  loadWrapUpFacts.mockReset()
})

describe("GET /api/flows/[id]/wrapup-facts", () => {
  it("refuses a caller who is not staff and reads nothing", async () => {
    requireStaffRoute.mockResolvedValue(NextResponse.json({ error: "Not authorized" }, { status: 403 }))
    const res = await GET(req, ctx)
    expect(res.status).toBe(403)
    expect(loadWrapUpFacts).not.toHaveBeenCalled()
  })

  it("returns the facts for staff", async () => {
    requireStaffRoute.mockResolvedValue(null)
    loadWrapUpFacts.mockResolvedValue({ ok: true, facts: { variant: "company", checkedAt: "2026-10-15T12:00:00Z" } })
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, facts: { variant: "company", checkedAt: "2026-10-15T12:00:00Z" } })
    expect(loadWrapUpFacts).toHaveBeenCalledWith("job-1")
  })

  it("passes the loader's error and status straight through (a job that is not a closure is a 400, not a silent empty panel)", async () => {
    requireStaffRoute.mockResolvedValue(null)
    loadWrapUpFacts.mockResolvedValue({ ok: false, status: 400, error: "This is not a Company Closure job." })
    const res = await GET(req, ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: "This is not a Company Closure job." })
  })

  it("turns an unexpected failure into a 500 with a message, never a silent success", async () => {
    requireStaffRoute.mockResolvedValue(null)
    loadWrapUpFacts.mockRejectedValue(new Error("db down"))
    const res = await GET(req, ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("the route file checks for staff first, before anything else (R-guard)", () => {
    const src = read("app/api/flows/[id]/wrapup-facts/route.ts")
    expect(src.indexOf("requireStaffRoute()")).toBeGreaterThan(-1)
    expect(src.indexOf("requireStaffRoute()")).toBeLessThan(src.indexOf("loadWrapUpFacts(params.id)"))
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/)
  })
})

describe("stage component wiring", () => {
  it("closure_wrapup is a known stage component and the layout parser keeps it", () => {
    expect(STAGE_COMPONENT_TYPES).toContain("closure_wrapup")
    expect(parseStageLayout({ components: [{ type: "closure_wrapup" }] })?.components.map((c) => c.type)).toEqual(["closure_wrapup"])
  })
  it("an unknown component type is still dropped (so the code must ship before the layout data)", () => {
    expect(parseStageLayout({ components: [{ type: "not_a_component" }] })?.components).toEqual([])
  })
  it("the workspace renderer renders it with the job id", () => {
    const src = read("components/flows/stage-renderer.tsx")
    expect(src).toContain("case 'closure_wrapup':")
    expect(src).toContain("<ClosureWrapupPanel key={key} serviceDeliveryId={serviceDelivery.id} />")
  })
})

describe("the browser panel", () => {
  const panel = read("components/flows/closure-wrapup-panel.tsx")
  it("is a client component that cannot pull in server-only code", () => {
    expect(panel.startsWith("'use client'")).toBe(true)
    expect(panel).not.toMatch(/supabase-admin|@\/lib\/services\/stages|wrapup-facts-load/)
    // the facts module imports the database client; the panel may only take TYPES from it
    expect(panel).toMatch(/import type \{[^}]*\} from '@\/lib\/closure\/wrapup-facts'/)
    expect(read("lib/closure/wrapup-email.ts")).not.toMatch(/^import (?!type)/m)
  })
  it("is read-only: it only ever GETs, and never writes", () => {
    expect(panel).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/)
    expect(panel).not.toMatch(/<input|<textarea|<select/)
  })
  it("surfaces the server's error and fails closed (R099, council)", () => {
    expect(panel).toContain("data.error || 'Could not read the Wrap-up facts.'")
    expect(panel).toContain("Closing stays off until this can be checked.")
  })
  it("opens Finance and Harbor in a new tab, never as a floating window", () => {
    expect(panel).toContain('target="_blank"')
    expect(panel).toContain('/finance?tab=clients&client=')
    expect(panel).toContain('facts.accountId')
    expect(panel).not.toMatch(/OPEN_WINDOW_EVENT|windows-context/)
  })
  it("never shows the company's EIN", () => {
    expect(panel).not.toMatch(/ein_number|\bein\b/i)
    expect(read("lib/closure/wrapup-facts-load.ts")).toMatch(/never returned|is never returned/)
  })
})

describe("the loader (read-only)", () => {
  const loader = read("lib/closure/wrapup-facts-load.ts")
  it("never writes", () => {
    expect(loader).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })
  it("each section is read on its own so one failure cannot read as 'nothing found'", () => {
    expect(loader).toContain("async function section<T>")
    expect(loader).toContain("Couldn't check ")
  })
  it("refuses a job that is not a Company Closure", () => {
    expect(loader).toContain("This is not a Company Closure job.")
  })
})

describe("migration 20261015-1600-closure-wrapup-panel", () => {
  const mig = read("scripts/migrations/20261015-1600-closure-wrapup-panel.sql")
  const undo = read("scripts/migrations/20261015-1600-closure-wrapup-panel.UNDO.sql")
  it("only touches the Company Closure Wrap-up step", () => {
    const updates = mig.match(/UPDATE public\.pipeline_stages[\s\S]*?;/g) ?? []
    expect(updates.length).toBeGreaterThan(0)
    for (const u of updates) expect(u).toContain("service_type = 'Company Closure' AND stage_name = 'Wrap-up'")
    for (const u of undo.match(/UPDATE public\.pipeline_stages[\s\S]*?;/g) ?? []) expect(u).toContain("service_type = 'Company Closure' AND stage_name = 'Wrap-up'")
  })
  it("empties the step to-dos and sets the panel layout", () => {
    expect(mig).toContain("auto_tasks   = '[]'::jsonb")
    expect(mig).toContain('{"components":[{"type":"closure_wrapup"}]}')
  })
  it("refuses to run when the Wrap-up step does not exist, and checks its own result", () => {
    expect(mig).toContain("run 20261015-1200-closure-wrapup-step.sql first")
    expect(mig).toContain("not in the expected state after the update")
  })
  it("the undo puts back exactly the three to-dos the base migration creates", () => {
    const base = read("scripts/migrations/20261015-1200-closure-wrapup-step.sql")
    for (const title of [
      "Cancel Registered Agent on Harbor Compliance",
      "Cancel CMRA/lease if active",
      "Stop the yearly renewals (RA + annual report) and clear their dates",
    ]) {
      expect(base).toContain(`"title": "${title}"`)
      expect(undo).toContain(`"title": "${title}"`)
    }
  })
})
