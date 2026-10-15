/**
 * The Wrap-up POP-UP on the Calendar (Open services). Antonio, 2026-10-15: "the Calendar is where we work day by day" — a Company
 * Closure on its Wrap-up step opens the pop-up on the Calendar row; it does not send the person to the job page, Finance or the CRM.
 *
 * Covers: the pop-up is chosen from the step's layout DATA (no service or step name in code); rows of other steps are untouched; the
 * Calendar row shows the button and the dialog; the dialog and the pop-up version of the panel contain no link out to Finance or the CRM.
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: vi.fn() } }))

import { buildOpenServices, type AccountInput, type JobInput, type StepInput } from "@/lib/open-services/build"
import { CALENDAR_POPUPS, popupFromLayout } from "@/lib/open-services/types"
import { parseParams } from "@/lib/open-services/params"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const NOW = new Date("2026-10-15T15:00:00Z")

describe("popupFromLayout", () => {
  it("finds the Wrap-up pop-up in a step layout", () => {
    expect(popupFromLayout({ components: [{ type: "info_panel" }, { type: "closure_wrapup" }] })).toBe("closure_wrapup")
    expect(popupFromLayout({ components: [{ type: "closure_wrapup" }] })).toBe("closure_wrapup")
  })
  it("is null for a layout without it, and for anything that is not a layout", () => {
    expect(popupFromLayout({ components: [{ type: "info_panel" }, { type: "suite_panel" }] })).toBeNull()
    expect(popupFromLayout({ components: [] })).toBeNull()
    expect(popupFromLayout({})).toBeNull()
    expect(popupFromLayout(null)).toBeNull()
    expect(popupFromLayout(undefined)).toBeNull()
    expect(popupFromLayout("closure_wrapup")).toBeNull()
    expect(popupFromLayout({ components: "closure_wrapup" })).toBeNull()
    expect(popupFromLayout({ components: [null, 3, "x", { type: 5 }] })).toBeNull()
  })
  it("knows exactly one pop-up today", () => {
    expect([...CALENDAR_POPUPS]).toEqual(["closure_wrapup"])
  })
})

describe("rows built from steps", () => {
  const steps: StepInput[] = [
    { service_type: "Svc", stage_name: "Early", stage_order: 1, waiting_on: "us", sla_days: 3, completes_service: false, stage_layout: null },
    { service_type: "Svc", stage_name: "Last chores", stage_order: 2, waiting_on: "us", sla_days: 5, completes_service: false, stage_layout: { components: [{ type: "info_panel" }, { type: "closure_wrapup" }] } },
    { service_type: "Svc", stage_name: "Done", stage_order: 3, waiting_on: "us", sla_days: 1, completes_service: true },
  ]
  const accounts: AccountInput[] = [{ id: "a1", company_name: "Acme LLC", is_test: false, is_internal: false, status: "Active" }]
  const job = (id: string, stage: string): JobInput => ({
    id, service_type: "Svc", stage, status: "active", stage_entered_at: "2026-10-14T12:00:00Z", created_at: "2026-09-01T12:00:00Z",
    account_id: "a1", contact_id: null, is_test: false, service_type_entry_id: null,
  })
  const rows = () =>
    buildOpenServices({ jobs: [job("j-early", "Early"), job("j-wrap", "Last chores")], steps, accounts, contacts: [], cards: [], now: NOW }, parseParams({}))
      .groups.flatMap((g) => g.rows)

  it("a job on a step whose layout asks for the pop-up gets it", () => {
    expect(rows().find((r) => r.id === "j-wrap")?.popup).toBe("closure_wrapup")
  })
  it("a job on any other step keeps the plain link to the job page", () => {
    const early = rows().find((r) => r.id === "j-early")
    expect(early?.popup).toBeNull()
    expect(early?.href).toBe("/flows/j-early")
  })
  it("a pop-up row still carries its job-page link (kept as a small secondary link)", () => {
    expect(rows().find((r) => r.id === "j-wrap")?.href).toBe("/flows/j-wrap")
  })
  it("a step missing from the settings has no pop-up", () => {
    const r = buildOpenServices({ jobs: [job("j-x", "No such step")], steps, accounts, contacts: [], cards: [], now: NOW }, parseParams({})).groups.flatMap((g) => g.rows)[0]
    expect(r.popup).toBeNull()
  })
})

describe("the Calendar row and the pop-up", () => {
  const view = read("components/open-services/open-services-view.tsx")
  const dialog = read("components/open-services/closure-wrapup-dialog.tsx")
  const panel = read("components/flows/closure-wrapup-panel.tsx")

  it("the row shows the pop-up button for a pop-up row and keeps 'Open workspace' for every other row", () => {
    expect(view).toContain("row.popup === 'closure_wrapup'")
    expect(view).toContain("Wrap up…")
    expect(view).toContain("<ClosureWrapupDialog")
    expect(view).toContain("jobId={row.id}")
    expect(view).toContain("Open workspace")
  })
  it("the Calendar code names no service (the pop-up comes from the step's layout data)", () => {
    for (const f of ["components/open-services/open-services-view.tsx", "components/open-services/closure-wrapup-dialog.tsx", "lib/open-services/types.ts", "lib/open-services/build.ts"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
      expect(code, f).not.toContain("Company Closure")
      expect(code, f).not.toContain("Wrap-up")
    }
  })
  it("the dialog is an accessible modal that Esc closes and that leaves the page behind it still", () => {
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toContain("aria-labelledby")
    expect(dialog).toContain("e.key === 'Escape'")
    expect(dialog).toContain("document.body.style.overflow = 'hidden'")
    expect(dialog).toContain("createPortal")
  })
  it("nothing in the dialog or its pop-up version of the panel sends the person out of the Calendar to Finance or the CRM", () => {
    const dialogBody = dialog.replace(/^import .*$/gm, "") // the import path of the panel is not a link
    expect(dialogBody).not.toMatch(/href=|<Link|router\.|window\.open|\/finance|\/accounts|\/flows/)
    expect(panel).toContain("{!popup && (")
    // the Finance link only exists inside the page version
    const financeAt = panel.indexOf("/finance?tab=clients&client=")
    expect(panel.slice(Math.max(0, financeAt - 400), financeAt)).toContain("{!popup && (")
  })
  it("the dialog is client-only code that reads through the staff-only route (no server code, no database)", () => {
    expect(dialog.startsWith("'use client'")).toBe(true)
    expect(dialog).not.toMatch(/supabase|lib\/services|wrapup-facts-load|fetch\(/)
  })
})

describe("the loader hands the step layout to the builder", () => {
  it("reads stage_layout with the other step settings and passes it on", () => {
    const load = read("lib/open-services/load.ts")
    expect(load).toContain("completes_service, stage_layout")
    expect(load).toContain("stage_layout: s.stage_layout")
  })
})
