/**
 * The OTHER doors that used to write an invoice type or a year nobody chose (dev job bea928e0, Antonio 2026-11-22):
 *   - both bank-feed routes wrote a fixed "One-Time Service" on every invoice made from a bank payment;
 *   - the recurring generator stamped a year on every cycle (a year on a "tax return" bill aims the database's tax-return rule);
 *   - the MCP invoice tool accepted a Payment Type and a year;
 *   - the card autopay run dropped every invoice with no hidden code (in SQL NULL <> 'credit' is not true), against Antonio's
 *     30 Aug 2026 rule "every invoice type except credit".
 * Each block fails if its change is undone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const { mockCreateTDInvoice } = vi.hoisted(() => ({ mockCreateTDInvoice: vi.fn() }))

vi.mock("@/lib/portal/td-invoice", () => ({ createTDInvoice: mockCreateTDInvoice }))
vi.mock("@/lib/portal/chat-events", () => ({ emitRecurringInvoiceGeneratedEvent: vi.fn(async () => undefined) }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: vi.fn(async () => undefined) }))
// A chain that answers every method with itself and resolves { data: null, error: null } when awaited.
vi.mock("@/lib/supabase-admin", () => {
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null, count: 0 }).then(res)
      return () => chain
    },
    apply() {
      return chain
    },
  })
  return { supabaseAdmin: chain }
})

import { generateRecurringInvoiceCycle } from "@/lib/billing/recurring-invoice-generate"

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

/** The text of the createTDInvoice({ ... }) call in a source file (up to its closing "})"). */
function createTDInvoiceCall(src: string): string {
  const start = src.indexOf("createTDInvoice({")
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf("\n    })", start)
  // Comments explain the change and may name the old label — only the code counts.
  return src.slice(start, end).replace(/^\s*\/\/.*$/gm, "")
}

describe("bank-feed invoices carry no invented Payment Type", () => {
  it.each([
    "app/api/feed/create-from-feed/route.ts",
    "app/api/clients/audit/[id]/create-service-from-feed/route.ts",
  ])("%s does not pass an installment to createTDInvoice", (file) => {
    const call = createTDInvoiceCall(read(file))
    expect(call).not.toMatch(/installment\s*:/)
    expect(call).not.toMatch(/One-Time Service/)
    expect(call).not.toMatch(/\byear\b\s*[:,]/)
  })
})

describe("the recurring generator stamps no year", () => {
  beforeEach(() => {
    mockCreateTDInvoice.mockReset()
    mockCreateTDInvoice.mockResolvedValue({ paymentId: "pay-1", expenseId: "exp-1", invoiceNumber: "INV-000010", total: 50, status: "Draft" })
  })

  it("creates the cycle's invoice with no year (and no installment or code unless the template itself carries one)", async () => {
    await generateRecurringInvoiceCycle({
      id: "tmpl-1",
      account_id: "30c2cd96-03e4-43cf-9536-81d961b18b1d",
      contact_id: null,
      label: "Monthly tax return fee",
      description: "Tax Return",
      line_items: [{ description: "Tax Return", unit_price: 50, quantity: 1 }],
      currency: "USD",
      frequency: "monthly",
      next_run_date: "2026-12-01",
      end_date: null,
      due_date_offset_days: 10,
      installment: null,
      payment_category: null,
      notes: null,
      message: null,
      bank_preference: null,
      payment_method: null,
    } as Parameters<typeof generateRecurringInvoiceCycle>[0])
    expect(mockCreateTDInvoice).toHaveBeenCalledTimes(1)
    const call = mockCreateTDInvoice.mock.calls[0][0] as Record<string, unknown>
    expect(call.year).toBeUndefined()
    expect(call.installment).toBeUndefined()
    expect(call.payment_category).toBeUndefined()
  })
})

describe("the MCP invoice tool no longer takes a Payment Type or a year", () => {
  it("portal_invoice_create has neither parameter, and says why", async () => {
    vi.resetModules()
    const tools: Array<{ name: string; description: string; schema: Record<string, unknown> }> = []
    const fakeServer = { tool: (name: string, description: string, schema: Record<string, unknown>) => { tools.push({ name, description, schema }) } }
    const { registerPortalTools } = await import("@/lib/mcp/tools/portal")
    registerPortalTools(fakeServer as never)
    const tool = tools.find((t) => t.name === "portal_invoice_create")
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.schema)).not.toContain("installment")
    expect(Object.keys(tool!.schema)).not.toContain("year")
    expect(tool!.description).toMatch(/never sets a Payment Type/)
    expect(tool!.description).toMatch(/Yearly installments are NOT made with this tool/)
  })

  it("its handler does not forward an installment or a year", () => {
    const src = read("lib/mcp/tools/portal.ts")
    const start = src.indexOf('"portal_invoice_create"')
    const body = src.slice(start, src.indexOf("portal_invoice_send", start))
    expect(body).not.toMatch(/installment:\s*installment/)
    expect(body).not.toMatch(/year:\s*year/)
  })
})

describe("card autopay includes an invoice with no hidden code", () => {
  const src = read("app/api/cron/card-autopay-charge/route.ts")

  it("names NULL explicitly instead of a bare 'not credit' (which drops NULL rows)", () => {
    expect(src).toContain('.or("payment_category.is.null,payment_category.neq.credit")')
    expect(src).not.toMatch(/\.neq\(\s*"payment_category"/)
  })

  it("still keeps the rest of the candidate rules (Sent, not settled, positive, due, autopay on)", () => {
    expect(src).toContain('.eq("invoice_status" as never, "Sent")')
    expect(src).toContain('.gt("amount", 0)')
    expect(src).toContain('.eq("accounts.autopay_card_enabled" as never, true)')
  })
})
