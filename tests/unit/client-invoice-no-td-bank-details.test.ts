import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// A client's OWN sales invoice (client_invoices) is between the client and the client's customer.
// Tony Durante's own bank accounts (the staff settings row, invoice_settings) have nothing to do with
// it and must never reach a client's invoice page or its API (dev job 1a23f5f1, Antonio 2026-10-08).
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

describe("a client's own invoice never carries Tony Durante's bank details", () => {
  it('the invoice API does not read invoice_settings or return payment methods', () => {
    const api = read('app/api/portal/invoices/[id]/route.ts')
    expect(api).not.toMatch(/invoice_settings/)
    expect(api).not.toMatch(/payment_methods/)
    expect(api).not.toMatch(/payment_gateways/)
  })

  it('the invoice page does not render the Pay Now panel', () => {
    const page = read('app/portal/invoices/[id]/page.tsx')
    expect(page).not.toMatch(/PayNow|pay-now|payment_methods/)
  })

  it("the client's own bank account for the invoice still comes from client_bank_accounts", () => {
    // Send + PDF print the CLIENT's selected bank account; this is the only bank data on a client invoice.
    expect(read('app/api/portal/invoices/[id]/send/route.ts')).toMatch(/client_bank_accounts/)
    expect(read('lib/portal/invoice-pdf.ts')).toMatch(/client_bank_accounts/)
  })
})
