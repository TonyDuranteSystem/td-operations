/**
 * Company Closure — the fixes from the bug hunt over the live closure flow (2026-11-08, dev job eaa4747e). Every case below was first
 * reproduced for real on the sandbox (real browser + worker) or seen live on production; the pure rules are tested here, the screens by shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifyOpenPayments, owedOf, paidOf, totalsByCurrency, type OpenPaymentRow } from "@/lib/closure/closing-payments"
import { closingBriefLines, type ClosingBrief } from "@/lib/closure/closing-brief"
import { closureProblemWarning, COMPANY_CLOSE_NOT_CONFIRMED, COMPANY_CLOSE_TOOL_HINT } from "@/lib/closure/closing-step"
import { withTrackingSaved, goBackExtraWarnings, TRACKING_DELETE_WARNING } from "@/lib/flows/go-back-warnings"
import { checkNoteFrom } from "@/lib/operations/close-company"
import { CHECK_CLEARED_MARKER } from "@/lib/closure/wizard-move-guard"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const row = (over: Partial<OpenPaymentRow> = {}): OpenPaymentRow => ({
  id: "p", invoice_number: "INV-1", status: "Pending", invoice_status: "Draft", amount: 150, amount_currency: "USD", amount_due: 150, amount_paid: 0, ...over,
})

describe("which open invoice rows closing may cancel", () => {
  it("a plain unpaid invoice is cancelled", () => {
    const c = classifyOpenPayments([row(), row({ id: "q", status: "Overdue", invoice_status: "Overdue", amount: 40, amount_due: 40 })])
    expect(c.cancel.map((r) => r.id)).toEqual(["p", "q"])
    expect(c.partPaid).toEqual([])
    expect(c.credits).toEqual([])
  })

  it("a part-paid invoice (money already received) is NOT cancelled — it is reported", () => {
    const c = classifyOpenPayments([row({ id: "part", invoice_status: "Partial", amount_paid: 100, amount_due: 50 })])
    expect(c.cancel).toEqual([])
    expect(c.partPaid.map((r) => r.id)).toEqual(["part"])
  })

  it("an unused credit note is not an invoice: by its invoice status or by its negative amount", () => {
    const c = classifyOpenPayments([row({ id: "c1", invoice_status: "Credit", amount: -25, amount_due: 0 }), row({ id: "c2", invoice_status: "Draft", amount: -397, amount_due: 0 })])
    expect(c.credits.map((r) => r.id)).toEqual(["c1", "c2"])
    expect(c.cancel).toEqual([])
  })

  it("a row whose status column is stale (its invoice status says Paid / Cancelled / Voided) is left alone and listed nowhere", () => {
    const c = classifyOpenPayments([row({ id: "a", invoice_status: "Paid" }), row({ id: "b", invoice_status: "cancelled" }), row({ id: "v", invoice_status: "Voided" })])
    expect(c).toEqual({ cancel: [], partPaid: [], credits: [] })
  })

  it("owed is the due amount when the row carries one (not the full amount), paid reads the received money, totals round to cents and group by currency", () => {
    expect(owedOf({ amount: 150, amount_due: 50 })).toBe(50)
    expect(owedOf({ amount: 150, amount_due: null })).toBe(150)
    expect(owedOf({ amount: "150.00", amount_due: "0" })).toBe(0)
    expect(paidOf({ amount_paid: "100" })).toBe(100)
    expect(paidOf({ amount_paid: null })).toBe(0)
    expect(totalsByCurrency([{ amount_currency: "usd", n: 0.1 }, { amount_currency: "USD", n: 0.2 }, { amount_currency: null, n: 1 }, { amount_currency: "EUR", n: 5 }], (r) => r.n)).toEqual({ USD: 1.3, EUR: 5 })
  })
})

describe("the question's invoice lines", () => {
  const base: ClosingBrief = {
    companyName: "Beta LLC", alreadyClosed: false, openServices: [], pendingDeadlines: 0, unpaid: { count: 0, totals: {} }, openTasks: 0, members: 0, hasLease: false, checkNote: null,
  }

  it("says what is still OWED on a part-paid invoice and that it will NOT be cancelled", () => {
    const lines = closingBriefLines({ ...base, partPaid: [{ invoice: "INV-9", paid: 100, owed: 50, currency: "USD" }] })
    expect(lines).toEqual(["Invoice INV-9 is part-paid ($100 of $150 received, $50 still owed) — it will NOT be cancelled: settle or refund it by hand."])
  })

  it("lists an unused credit note apart from the unpaid invoices", () => {
    const lines = closingBriefLines({ ...base, unpaid: { count: 1, totals: { USD: 40 } }, credits: { count: 1, totals: { USD: 25 } } })
    expect(lines).toContain("1 unpaid invoice ($40) will be cancelled — collect first if it is still owed.")
    expect(lines).toContain("1 unused credit note ($25) stays on the account — a credit is not an invoice, so closing does not cancel it.")
    expect(closingBriefLines({ ...base, credits: { count: 2, totals: { USD: 50 } } })).toContain("2 unused credit notes ($50) stay on the account — a credit is not an invoice, so closing does not cancel it.")
  })

  it("a brief without the new fields (older callers) reads as before", () => {
    expect(closingBriefLines({ ...base, unpaid: { count: 2, totals: { USD: 120 } } })).toEqual(["2 unpaid invoices ($120) will be cancelled — collect first if it is still owed."])
  })
})

describe("closing problems are said on every door", () => {
  it("builds the staff warning from the Closure problem lines, and is null when nothing failed", () => {
    expect(closureProblemWarning(["Cancelled 1 unpaid invoice (40 USD)", "Closure problem: could not cancel invoice INV-1: boom", "Closure problem: a second thing"]))
      .toBe("The job finished, but closing the company did not fully work: could not cancel invoice INV-1: boom · a second thing. Check the company before relying on it.")
    expect(closureProblemWarning(["Cancelled 1 unpaid invoice"])).toBeNull()
    expect(closureProblemWarning(undefined)).toBeNull()
  })

  it("the refusal is written for staff; the MCP tool adds its own sentence for an agent", () => {
    expect(COMPANY_CLOSE_NOT_CONFIRMED).not.toContain("From a tool")
    expect(COMPANY_CLOSE_NOT_CONFIRMED).toContain("Open the job in its workspace")
    expect(COMPANY_CLOSE_TOOL_HINT).toContain("confirm_company_close")
    expect(read("lib/mcp/tools/operations.ts")).toContain("COMPANY_CLOSE_TOOL_HINT")
  })

  it("the advance route and the step bar's move use the same helper; the step bar toasts what it returns", () => {
    expect(read("app/api/flows/[id]/advance/route.ts")).toContain("closureProblemWarning(result.auto_triggers)")
    expect(read("lib/operations/move-stage.ts")).toContain("closureProblemWarning(adv.auto_triggers)")
    const route = read("app/api/flows/[id]/set-stage/route.ts")
    expect(route).toContain("warnings: result.warnings ?? []")
    expect(route).toContain("warning: result.warning ?? null")
    const stepper = read("components/flows/stage-stepper.tsx")
    expect(stepper).toContain("toast.warning(w")
    expect(stepper).toContain("toast.warning(data.warning")
  })

  it("the finish button keeps its warning as a toast (the inline line goes with the refresh) and the closing step writes the problems on the job", () => {
    expect(read("components/flows/action-buttons.tsx")).toContain("toast.warning(data.warning")
    const sd = read("lib/service-delivery.ts")
    expect(sd).toContain("CLOSURE PROBLEM: closing the company did not fully work")
    expect(sd).toContain("service_delivery_notes")
  })
})

describe("a move back over a saved IRS tracking number says so first", () => {
  it("the step bar's move back asks with the same extra lines as Go Back, and the page hands them over", () => {
    const stepper = read("components/flows/stage-stepper.tsx")
    expect(stepper).toContain("backWarnings")
    expect(stepper).toContain("movingBack ? moveBackLines : []")
    expect(read("app/(dashboard)/flows/[id]/page.tsx")).toContain("backWarnings={goBackExtras}")
  })

  it("a number saved AFTER the page loaded still shows up in the question — Go Back and the step bar both use the hook that listens for it", () => {
    expect(withTrackingSaved([], true)).toEqual([TRACKING_DELETE_WARNING])
    expect(withTrackingSaved([], false)).toEqual([])
    // not said twice when the page already knew about the number
    expect(withTrackingSaved([TRACKING_DELETE_WARNING], true)).toEqual([TRACKING_DELETE_WARNING])
    // keeps the page's other lines (e.g. "the company stays Closed")
    const base = goBackExtraWarnings({ hasTrackingNumber: false, closureCompanyClosed: true })
    expect(withTrackingSaved(base, true)).toEqual([TRACKING_DELETE_WARNING, ...base])
    expect(read("components/flows/go-back-button.tsx")).toContain("useGoBackWarnings(serviceDeliveryId, extraWarnings)")
    expect(read("components/flows/stage-stepper.tsx")).toContain("useGoBackWarnings(serviceDeliveryId, backWarnings)")
    const hook = read("components/flows/use-go-back-warnings.ts")
    expect(hook).toContain("FLOW_TRACKING_SAVED_EVENT")
  })
})

describe("a corrected company name clears the old red warning", () => {
  const check = { body: "Closure wizard: package filed in the person's folder. CHECK: linked to A, client wrote B." }
  const cleared = { body: `Closure wizard: ${CHECK_CLEARED_MARKER} the client now wrote A, which matches the company this job is linked to.` }

  it("the newest CHECK note wins; a newer 'CHECK cleared' note means no warning (notes are newest first)", () => {
    expect(checkNoteFrom([check])).toBe("linked to A, client wrote B.")
    expect(checkNoteFrom([cleared, check])).toBeNull()
    // a NEW wrong submission after the clearing raises the warning again
    const wrongAgain = { body: "Closure wizard: package filed. CHECK: linked to A, client wrote C." }
    expect(checkNoteFrom([wrongAgain, cleared, check])).toBe("linked to A, client wrote C.")
  })

  it("the marker never reads as a CHECK line itself", () => {
    expect(CHECK_CLEARED_MARKER).not.toContain("CHECK:")
    expect(checkNoteFrom([cleared])).toBeNull()
  })

  it("the wizard route writes the clearing note when the answers match and an earlier CHECK is still the latest", () => {
    const route = read("app/api/closure-form-completed/route.ts")
    expect(route).toContain("CHECK_CLEARED_MARKER")
    expect(route).toContain("if (!destination?.disagreement)")
    expect(read("lib/operations/close-company.ts")).toContain('.ilike("body", "%CHECK%")')
  })
})

// ── the step bar's move: warnings from every step back, closing problems going forward ──────────────────────────────────
const m = vi.hoisted(() => ({
  stage: "Waiting for the IRS",
  reverts: [] as Array<Record<string, unknown>>,
  advance: {} as Record<string, unknown>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        order: () => Promise.resolve({
          data: table === "pipeline_stages"
            ? [
                { stage_name: "Data Collection", stage_order: 1 },
                { stage_name: "State Compliance Check", stage_order: 2 },
                { stage_name: "State Dissolution Filing", stage_order: 3 },
                { stage_name: "IRS Closure", stage_order: 4 },
                { stage_name: "Waiting for the IRS", stage_order: 5 },
                { stage_name: "Closing", stage_order: 6 },
              ]
            : [],
          error: null,
        }),
        maybeSingle: () => Promise.resolve({ data: { id: "job-1", service_type: "Company Closure", stage: m.stage }, error: null }),
      }
      return api
    },
  },
}))
vi.mock("@/lib/operations/service-delivery", () => ({ revertServiceDelivery: vi.fn(async () => m.reverts.shift() ?? { success: false, error: "no more reverts" }) }))
vi.mock("@/lib/service-delivery", () => ({ advanceServiceDelivery: vi.fn(async () => m.advance) }))

import { moveServiceDeliveryToStage } from "@/lib/operations/move-stage"

describe("moveServiceDeliveryToStage hands the warnings to the step bar", () => {
  beforeEach(() => {
    m.stage = "Waiting for the IRS"
    m.reverts = []
    m.advance = {}
  })

  it("going back collects each step's warnings once (the deleted tracking number, a company that stays Closed)", async () => {
    m.reverts = [
      { success: true, to_stage: "IRS Closure", documents_deleted: 0, warnings: ["The saved IRS tracking number was removed"] },
      { success: true, to_stage: "State Dissolution Filing", documents_deleted: 1, warnings: ["The saved IRS tracking number was removed", "The company stays Closed"] },
    ]
    const r = await moveServiceDeliveryToStage({ delivery_id: "job-1", target_stage: "State Dissolution Filing" })
    expect(r).toMatchObject({ success: true, outcome: "reverted", documents_deleted: 1 })
    expect(r.warnings).toEqual(["The saved IRS tracking number was removed", "The company stays Closed"])
  })

  it("a move back with nothing to warn about carries no warnings", async () => {
    m.reverts = [{ success: true, to_stage: "IRS Closure", documents_deleted: 0 }]
    const r = await moveServiceDeliveryToStage({ delivery_id: "job-1", target_stage: "IRS Closure" })
    expect(r.success).toBe(true)
    expect(r.warnings).toBeUndefined()
  })

  it("going forward over a closing that did not fully work returns the staff warning", async () => {
    m.advance = { success: true, from_stage: "Waiting for the IRS", to_stage: "Closing", to_order: 6, is_completed: true, created_tasks: [], failed_tasks: [], auto_triggers: ["Closure problem: could not cancel invoice INV-1: boom"] }
    const r = await moveServiceDeliveryToStage({ delivery_id: "job-1", target_stage: "Closing", company_close_confirmed: true })
    expect(r).toMatchObject({ success: true, outcome: "advanced", completed: true })
    expect(r.warning).toContain("closing the company did not fully work: could not cancel invoice INV-1: boom")
  })

  it("going forward with a clean closing has no warning", async () => {
    m.advance = { success: true, from_stage: "Waiting for the IRS", to_stage: "Closing", to_order: 6, is_completed: true, created_tasks: [], failed_tasks: [], auto_triggers: ["Cancelled 1 unpaid invoice (40 USD)"] }
    const r = await moveServiceDeliveryToStage({ delivery_id: "job-1", target_stage: "Closing", company_close_confirmed: true })
    expect(r.warning).toBeNull()
  })
})
