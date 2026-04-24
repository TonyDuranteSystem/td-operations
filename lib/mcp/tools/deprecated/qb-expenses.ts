/**
 * QuickBooks Expense/Bill MCP Tools
 *
 * Tools:
 *   qb_search_vendors     — Search vendor directory
 *   qb_create_bill        — Create a vendor bill (AP)
 *   qb_list_bills         — List/filter vendor bills
 *   qb_record_bill_payment — Mark bill(s) as paid
 *   qb_list_bill_payments — List bill payments made
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { qbApiCall, findOrCreateVendor } from "@/lib/quickbooks"

export function registerQbExpenseTools(server: McpServer) {

  // ───────────────────────────────────────────────────────────
  // qb_search_vendors
  // ───────────────────────────────────────────────────────────
  server.tool(
    "qb_search_vendors",
    `Search QuickBooks Online vendors by name or email. Returns vendor ID, display name, email, phone, balance, and active status. Use this to find vendors before creating bills.`,
    {
      query: z.string().optional().describe("Search text (matches display name or company name)"),
      active_only: z.boolean().optional().default(true).describe("Only return active vendors (default true)"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async (params) => {
      try {
        const conditions: string[] = []
        if (params.active_only !== false) conditions.push("Active = true")

        const queryStr = conditions.length
          ? `SELECT * FROM Vendor WHERE ${conditions.join(' AND ')} MAXRESULTS ${params.limit ?? 50}`
          : `SELECT * FROM Vendor MAXRESULTS ${params.limit ?? 50}`

        const result = await qbApiCall(`/query?query=${encodeURIComponent(queryStr)}`)
        const vendors = result.QueryResponse?.Vendor || []

        // Filter by name if query provided
        const filtered = params.query
          ? vendors.filter((v: Record<string, unknown>) => {
              const name = ((v.DisplayName as string) || '').toLowerCase()
              const company = ((v.CompanyName as string) || '').toLowerCase()
              const email = ((v.PrimaryEmailAddr as Record<string, string>)?.Address || '').toLowerCase()
              const q = params.query!.toLowerCase()
              return name.includes(q) || company.includes(q) || email.includes(q)
            })
          : vendors

        if (!filtered.length) {
          return { content: [{ type: "text" as const, text: "📭 No vendors found." }] }
        }

        const lines = [`Found ${filtered.length} vendor(s)\n`]
        for (const v of filtered) {
          const email = (v.PrimaryEmailAddr as Record<string, string>)?.Address || ''
          const phone = (v.PrimaryPhone as Record<string, string>)?.FreeFormNumber || ''
          const balance = v.Balance ?? 0
          lines.push(`**${v.DisplayName}** (ID: ${v.Id})`)
          if (email) lines.push(`  Email: ${email}`)
          if (phone) lines.push(`  Phone: ${phone}`)
          lines.push(`  Balance: $${Number(balance).toFixed(2)} | Active: ${v.Active !== false ? 'Yes' : 'No'}`)
          lines.push(``)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // qb_create_bill
  // ───────────────────────────────────────────────────────────
  server.tool(
    "qb_create_bill",
    `Create a new vendor bill (expense) in QuickBooks Online. Automatically finds the vendor by name or creates a new one. Provide line items with description and amount. Returns the created bill with ID and total. Use qb_search_vendors first to verify the vendor name.`,
    {
      vendor_name: z.string().describe("Vendor display name (exact match or will be created)"),
      vendor_email: z.string().optional().describe("Vendor email (used if creating new vendor)"),
      line_items: z.array(z.object({
        description: z.string().describe("Line item description"),
        amount: z.number().describe("Line item amount"),
        quantity: z.number().optional().describe("Quantity (default 1)"),
      })).min(1).describe("Bill line items"),
      due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      txn_date: z.string().optional().describe("Transaction/invoice date (YYYY-MM-DD, default: today)"),
      ref_number: z.string().optional().describe("Vendor's invoice/reference number"),
      memo: z.string().optional().describe("Private memo / note"),
    },
    async (params) => {
      try {
        // Find or create vendor
        const vendorRef = await findOrCreateVendor(params.vendor_name, params.vendor_email)

        // Build bill object
        const bill: Record<string, unknown> = {
          VendorRef: {
            value: vendorRef.id,
            name: vendorRef.name,
          },
          Line: params.line_items.map((item, index) => ({
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: item.amount * (item.quantity || 1),
            Description: item.description,
            AccountBasedExpenseLineDetail: {
              AccountRef: {
                // "Services" or similar expense account — QB will use default if not specified
                // We use a generic approach: let QB auto-assign
              },
            },
            LineNum: index + 1,
          })),
        }

        if (params.txn_date) bill.TxnDate = params.txn_date
        if (params.due_date) bill.DueDate = params.due_date
        if (params.ref_number) bill.DocNumber = params.ref_number
        if (params.memo) bill.PrivateNote = params.memo

        const result = await qbApiCall('/bill', {
          method: 'POST',
          body: bill,
        })

        const b = result.Bill
        const lines = [
          `✅ Bill created`,
          ``,
          `ID: ${b.Id}`,
          `Vendor: ${vendorRef.name}`,
          b.DocNumber ? `Ref #: ${b.DocNumber}` : null,
          `Date: ${b.TxnDate}`,
          b.DueDate ? `Due: ${b.DueDate}` : null,
          `Total: $${Number(b.TotalAmt).toFixed(2)}`,
          `Balance: $${Number(b.Balance).toFixed(2)}`,
          ``,
          `Use **qb_record_bill_payment** to mark it as paid.`,
        ].filter(Boolean)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // qb_list_bills
  // ───────────────────────────────────────────────────────────
  server.tool(
    "qb_list_bills",
    `List vendor bills from QuickBooks Online. Filter by vendor name, status (Open/Paid/Overdue), or date range. Returns bill number, vendor, amount, balance due, due date, and status. For CRM payment data, use crm_search_payments instead.`,
    {
      vendor_name: z.string().optional().describe("Filter by vendor display name (partial match)"),
      status: z.string().optional().describe("Filter: Open, Paid, Overdue"),
      start_date: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async (params) => {
      try {
        const conditions: string[] = []
        if (params.start_date) conditions.push(`TxnDate >= '${params.start_date}'`)
        if (params.end_date) conditions.push(`TxnDate <= '${params.end_date}'`)

        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
        const queryStr = `SELECT * FROM Bill${where} ORDERBY TxnDate DESC MAXRESULTS ${params.limit ?? 50}`

        const result = await qbApiCall(`/query?query=${encodeURIComponent(queryStr)}`)
        let bills = result.QueryResponse?.Bill || []

        // In-memory filters
        if (params.vendor_name) {
          const q = params.vendor_name.toLowerCase()
          bills = bills.filter((b: Record<string, unknown>) =>
            ((b.VendorRef as Record<string, string>)?.name || '').toLowerCase().includes(q)
          )
        }

        const today = new Date().toISOString().slice(0, 10)
        if (params.status) {
          const s = params.status.toLowerCase()
          bills = bills.filter((b: Record<string, unknown>) => {
            const balance = Number(b.Balance || 0)
            const due = (b.DueDate as string) || ''
            if (s === 'paid') return balance === 0
            if (s === 'open') return balance > 0
            if (s === 'overdue') return balance > 0 && due < today
            return true
          })
        }

        if (!bills.length) {
          return { content: [{ type: "text" as const, text: "📭 No bills found matching filters." }] }
        }

        // Aggregate
        const totalAmt = bills.reduce((s: number, b: Record<string, unknown>) => s + Number(b.TotalAmt || 0), 0)
        const totalBalance = bills.reduce((s: number, b: Record<string, unknown>) => s + Number(b.Balance || 0), 0)

        const lines = [
          `Found ${bills.length} bill(s) — Total: $${totalAmt.toFixed(2)}, Outstanding: $${totalBalance.toFixed(2)}\n`,
        ]

        for (const b of bills) {
          const vendor = (b.VendorRef as Record<string, string>)?.name || 'Unknown'
          const balance = Number(b.Balance || 0)
          const total = Number(b.TotalAmt || 0)
          const due = (b.DueDate as string) || ''
          const status = balance === 0 ? '✅ Paid' : (due < today ? '🔴 Overdue' : '🟡 Open')

          lines.push(`**${vendor}** — $${total.toFixed(2)} ${status}`)
          lines.push(`  ID: ${b.Id}${b.DocNumber ? ` | Ref: ${b.DocNumber}` : ''} | Date: ${b.TxnDate}${due ? ` | Due: ${due}` : ''}`)
          if (balance > 0 && balance !== total) lines.push(`  Balance: $${balance.toFixed(2)}`)
          lines.push(``)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // qb_record_bill_payment
  // ───────────────────────────────────────────────────────────
  server.tool(
    "qb_record_bill_payment",
    `Record a payment against one or more QuickBooks vendor bills. This marks the bill(s) as Paid (balance = 0). Use this for vendor bills already paid (via card, bank transfer, etc.). Provide the bill ID(s) — the tool auto-detects the vendor and amount. WORKFLOW: qb_create_bill → qb_record_bill_payment.`,
    {
      bill_ids: z.array(z.string()).min(1).describe("QuickBooks Bill ID(s) to mark as paid (from qb_list_bills)"),
      payment_method: z.string().optional().describe("Payment method (e.g., 'Credit Card', 'Bank Transfer', 'Check')"),
      payment_date: z.string().optional().describe("Payment date (YYYY-MM-DD). Defaults to today."),
      reference_number: z.string().optional().describe("Reference/confirmation number for the payment"),
      memo: z.string().optional().describe("Private memo about the payment"),
    },
    async (params) => {
      try {
        // Fetch each bill to get vendor + amount
        const bills: Array<Record<string, unknown>> = []
        for (const billId of params.bill_ids) {
          const result = await qbApiCall(`/bill/${billId}`)
          bills.push(result.Bill)
        }

        // All bills should be from the same vendor
        const vendorRef = bills[0].VendorRef as Record<string, string>
        const totalAmt = bills.reduce((s, b) => s + Number(b.Balance || b.TotalAmt || 0), 0)

        // Build BillPayment
        const payment: Record<string, unknown> = {
          VendorRef: {
            value: vendorRef.value,
            name: vendorRef.name,
          },
          TotalAmt: totalAmt,
          PayType: 'Check', // Generic — "Check" is the default for non-credit-card
          CheckPayment: {
            // QB requires either CheckPayment or CreditCardPayment based on PayType
            BankAccountRef: {
              // Will use default bank account
            },
          },
          Line: bills.map(b => ({
            Amount: Number(b.Balance || b.TotalAmt || 0),
            LinkedTxn: [{
              TxnId: b.Id,
              TxnType: 'Bill',
            }],
          })),
        }

        if (params.payment_date) payment.TxnDate = params.payment_date
        if (params.reference_number) payment.DocNumber = params.reference_number
        if (params.memo) payment.PrivateNote = params.memo

        const result = await qbApiCall('/billpayment', {
          method: 'POST',
          body: payment,
        })

        const bp = result.BillPayment
        const lines = [
          `✅ Bill payment recorded`,
          ``,
          `Payment ID: ${bp.Id}`,
          `Vendor: ${vendorRef.name}`,
          `Amount: $${Number(bp.TotalAmt).toFixed(2)}`,
          `Date: ${bp.TxnDate}`,
          params.payment_method ? `Method: ${params.payment_method}` : null,
          params.reference_number ? `Ref #: ${params.reference_number}` : null,
          `Bills paid: ${params.bill_ids.join(', ')}`,
        ].filter(Boolean)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ───────────────────────────────────────────────────────────
  // qb_list_bill_payments
  // ───────────────────────────────────────────────────────────
  server.tool(
    "qb_list_bill_payments",
    `List bill payments made in QuickBooks Online. Filter by vendor name or date range. Returns payment amount, date, vendor, and linked bills.`,
    {
      vendor_name: z.string().optional().describe("Filter by vendor name (partial match)"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async (params) => {
      try {
        const conditions: string[] = []
        if (params.start_date) conditions.push(`TxnDate >= '${params.start_date}'`)
        if (params.end_date) conditions.push(`TxnDate <= '${params.end_date}'`)

        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
        const queryStr = `SELECT * FROM BillPayment${where} ORDERBY TxnDate DESC MAXRESULTS ${params.limit ?? 50}`

        const result = await qbApiCall(`/query?query=${encodeURIComponent(queryStr)}`)
        let payments = result.QueryResponse?.BillPayment || []

        if (params.vendor_name) {
          const q = params.vendor_name.toLowerCase()
          payments = payments.filter((p: Record<string, unknown>) =>
            ((p.VendorRef as Record<string, string>)?.name || '').toLowerCase().includes(q)
          )
        }

        if (!payments.length) {
          return { content: [{ type: "text" as const, text: "📭 No bill payments found." }] }
        }

        const totalPaid = payments.reduce((s: number, p: Record<string, unknown>) => s + Number(p.TotalAmt || 0), 0)
        const lines = [`Found ${payments.length} bill payment(s) — Total: $${totalPaid.toFixed(2)}\n`]

        for (const p of payments) {
          const vendor = (p.VendorRef as Record<string, string>)?.name || 'Unknown'
          const amt = Number(p.TotalAmt || 0)
          lines.push(`**${vendor}** — $${amt.toFixed(2)}`)
          lines.push(`  ID: ${p.Id} | Date: ${p.TxnDate}${p.DocNumber ? ` | Ref: ${p.DocNumber}` : ''}`)
          lines.push(``)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

} // end registerQbExpenseTools
