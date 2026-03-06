/**
 * QuickBooks MCP Tools
 * Wraps existing quickbooks.ts functions as MCP-compatible tools.
 * Used by the Remote MCP server at /api/mcp.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { qbApiCall, createInvoice, getActiveToken } from "@/lib/quickbooks"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerQbTools(server: McpServer) {

  // ═══════════════════════════════════════
  // qb_list_invoices
  // ═══════════════════════════════════════
  server.tool(
    "qb_list_invoices",
    "List invoices from QuickBooks. Optionally filter by customer name, status (Open/Paid/Overdue), or date range. Returns invoice number, customer, amount, balance, due date, and status.",
    {
      customer_name: z.string().optional().describe("Filter by customer display name (partial match)"),
      status: z.enum(["Open", "Paid", "Overdue"]).optional().describe("Invoice status filter"),
      start_date: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      limit: z.number().optional().default(50).describe("Max results (default 50, max 200)"),
    },
    async ({ customer_name, status, start_date, end_date, limit }) => {
      try {
        // Build QB SQL query
        let sql = "SELECT * FROM Invoice"
        const conditions: string[] = []

        if (customer_name) {
          conditions.push(`CustomerRef.name LIKE '%${customer_name.replace(/'/g, "\\''")}%'`)
        }

        if (start_date) {
          conditions.push(`TxnDate >= '${start_date}'`)
        }
        if (end_date) {
          conditions.push(`TxnDate <= '${end_date}'`)
        }

        if (conditions.length > 0) {
          sql += " WHERE " + conditions.join(" AND ")
        }

        sql += ` ORDERBY TxnDate DESC MAXRESULTS ${Math.min(limit || 50, 200)}`

        const query = encodeURIComponent(sql)
        const result = await qbApiCall(`/query?query=${query}`)

        let invoices = result.QueryResponse?.Invoice || []

        // Filter by status in memory (QB doesn't have a direct status field in query)
        if (status) {
          const now = new Date()
          invoices = invoices.filter((inv: Record<string, unknown>) => {
            const balance = inv.Balance as number
            const dueDate = new Date(inv.DueDate as string)

            if (status === "Paid") return balance === 0
            if (status === "Open") return balance > 0 && dueDate >= now
            if (status === "Overdue") return balance > 0 && dueDate < now
            return true
          })
        }

        // Format output
        const formatted = invoices.map((inv: Record<string, unknown>) => ({
          id: inv.Id,
          doc_number: inv.DocNumber,
          customer: (inv.CustomerRef as Record<string, unknown>)?.name,
          date: inv.TxnDate,
          due_date: inv.DueDate,
          total: inv.TotalAmt,
          balance: inv.Balance,
          currency: (inv.CurrencyRef as Record<string, unknown>)?.value || "USD",
          email_status: inv.EmailStatus,
          status: (inv.Balance as number) === 0
            ? "Paid"
            : new Date(inv.DueDate as string) < new Date()
              ? "Overdue"
              : "Open",
        }))

        // Calculate totals
        const totalAmount = formatted.reduce((sum: number, i: Record<string, unknown>) => sum + ((i.total as number) || 0), 0)
        const totalBalance = formatted.reduce((sum: number, i: Record<string, unknown>) => sum + ((i.balance as number) || 0), 0)

        const summary = `Found ${formatted.length} invoices | Total: $${totalAmount.toLocaleString()} | Outstanding: $${totalBalance.toLocaleString()}`

        return {
          content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(formatted, null, 2)}` }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error listing invoices: ${(err as Error).message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // qb_search_customers
  // ═══════════════════════════════════════
  server.tool(
    "qb_search_customers",
    "Search QuickBooks customers by name, email, or company. Returns customer ID, display name, email, phone, balance, currency, and active status.",
    {
      query: z.string().optional().describe("Search text (matches display name, company name, or email)"),
      active_only: z.boolean().optional().default(true).describe("Only return active customers (default true)"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ query, active_only, limit }) => {
      try {
        let sql = "SELECT * FROM Customer"
        const conditions: string[] = []

        if (query) {
          conditions.push(`DisplayName LIKE '%${query.replace(/'/g, "\\''")}%'`)
        }
        if (active_only !== false) {
          conditions.push("Active = true")
        }

        if (conditions.length > 0) {
          sql += " WHERE " + conditions.join(" AND ")
        }

        sql += ` ORDERBY DisplayName MAXRESULTS ${Math.min(limit || 50, 200)}`

        const encodedQuery = encodeURIComponent(sql)
        const result = await qbApiCall(`/query?query=${encodedQuery}`)

        const customers = result.QueryResponse?.Customer || []

        const formatted = customers.map((c: Record<string, unknown>) => ({
          id: c.Id,
          display_name: c.DisplayName,
          company_name: c.CompanyName,
          email: (c.PrimaryEmailAddr as Record<string, unknown>)?.Address,
          phone: (c.PrimaryPhone as Record<string, unknown>)?.FreeFormNumber,
          balance: c.Balance,
          currency: (c.CurrencyRef as Record<string, unknown>)?.value || "USD",
          active: c.Active,
          notes: c.Notes,
        }))

        return {
          content: [{ type: "text" as const, text: `Found ${formatted.length} customers\n\n${JSON.stringify(formatted, null, 2)}` }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error searching customers: ${(err as Error).message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // qb_list_payments
  // ═══════════════════════════════════════
  server.tool(
    "qb_list_payments",
    "List payments received in QuickBooks. Optionally filter by customer name or date range. Returns payment amount, date, method, and linked invoice.",
    {
      customer_name: z.string().optional().describe("Filter by customer name"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ customer_name, start_date, end_date, limit }) => {
      try {
        let sql = "SELECT * FROM Payment"
        const conditions: string[] = []

        if (customer_name) {
          conditions.push(`CustomerRef.name LIKE '%${customer_name.replace(/'/g, "\\''")}%'`)
        }
        if (start_date) {
          conditions.push(`TxnDate >= '${start_date}'`)
        }
        if (end_date) {
          conditions.push(`TxnDate <= '${end_date}'`)
        }

        if (conditions.length > 0) {
          sql += " WHERE " + conditions.join(" AND ")
        }

        sql += ` ORDERBY TxnDate DESC MAXRESULTS ${Math.min(limit || 50, 200)}`

        const encodedQuery = encodeURIComponent(sql)
        const result = await qbApiCall(`/query?query=${encodedQuery}`)

        const payments = result.QueryResponse?.Payment || []

        const formatted = payments.map((p: Record<string, unknown>) => ({
          id: p.Id,
          date: p.TxnDate,
          customer: (p.CustomerRef as Record<string, unknown>)?.name,
          amount: p.TotalAmt,
          currency: (p.CurrencyRef as Record<string, unknown>)?.value || "USD",
          payment_method: (p.PaymentMethodRef as Record<string, unknown>)?.name,
          memo: p.PrivateNote,
          unapplied: p.UnappliedAmt,
        }))

        const totalReceived = formatted.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0)

        return {
          content: [{ type: "text" as const, text: `Found ${formatted.length} payments | Total received: $${totalReceived.toLocaleString()}\n\n${JSON.stringify(formatted, null, 2)}` }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error listing payments: ${(err as Error).message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // qb_get_company_info
  // ═══════════════════════════════════════
  server.tool(
    "qb_get_company_info",
    "Get QuickBooks company info and connection status. Returns company name, country, fiscal year, and token expiry status.",
    {},
    async () => {
      try {
        const realmId = process.env.QB_REALM_ID!

        // Get company info from QB
        const result = await qbApiCall(`/companyinfo/${realmId}`)
        const info = result.CompanyInfo

        // Get token status from Supabase
        const { data: token } = await supabaseAdmin
          .from('qb_tokens')
          .select('access_token_expires_at, refresh_token_expires_at, updated_at')
          .eq('realm_id', realmId)
          .eq('is_active', true)
          .single()

        const now = new Date()
        const accessExpiry = token ? new Date(token.access_token_expires_at) : null
        const refreshExpiry = token ? new Date(token.refresh_token_expires_at) : null

        const output = {
          company: {
            name: info.CompanyName,
            legal_name: info.LegalName,
            country: info.Country,
            fiscal_year_start: info.FiscalYearStartMonth,
            email: info.Email?.Address,
            phone: info.PrimaryPhone?.FreeFormNumber,
          },
          connection: {
            realm_id: realmId,
            status: "connected",
            access_token_expires: accessExpiry?.toISOString(),
            access_token_valid: accessExpiry ? accessExpiry > now : false,
            refresh_token_expires: refreshExpiry?.toISOString(),
            refresh_token_valid: refreshExpiry ? refreshExpiry > now : false,
            refresh_token_days_remaining: refreshExpiry
              ? Math.floor((refreshExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
              : null,
            last_refresh: token?.updated_at,
          },
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error getting company info: ${(err as Error).message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // qb_create_invoice
  // ═══════════════════════════════════════
  server.tool(
    "qb_create_invoice",
    "Create a new invoice in QuickBooks. Automatically finds or creates the customer. Returns the created invoice with ID and doc number.",
    {
      customer_name: z.string().describe("Customer display name (exact match or will be created)"),
      customer_email: z.string().optional().describe("Customer email (used if creating new customer)"),
      line_items: z.array(z.object({
        description: z.string().describe("Line item description"),
        amount: z.number().describe("Unit price"),
        quantity: z.number().optional().describe("Quantity (default 1)"),
      })).min(1).describe("Invoice line items"),
      due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      memo: z.string().optional().describe("Private memo / note"),
    },
    async ({ customer_name, customer_email, line_items, due_date, memo }) => {
      try {
        const result = await createInvoice({
          customerName: customer_name,
          customerEmail: customer_email,
          lineItems: line_items,
          dueDate: due_date,
          memo,
        })

        const invoice = result.Invoice

        const output = {
          id: invoice.Id,
          doc_number: invoice.DocNumber,
          customer: invoice.CustomerRef?.name,
          total: invoice.TotalAmt,
          balance: invoice.Balance,
          due_date: invoice.DueDate,
          currency: invoice.CurrencyRef?.value || "USD",
          status: "Created",
          message: `Invoice #${invoice.DocNumber} created successfully for ${invoice.CustomerRef?.name}`,
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error creating invoice: ${(err as Error).message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // qb_token_status
  // ═══════════════════════════════════════
  server.tool(
    "qb_token_status",
    "Check the health of the QuickBooks OAuth2 connection. Returns access token and refresh token expiry times, and whether refresh is needed.",
    {},
    async () => {
      try {
        const realmId = process.env.QB_REALM_ID!

        const { data: token, error } = await supabaseAdmin
          .from('qb_tokens')
          .select('*')
          .eq('realm_id', realmId)
          .eq('is_active', true)
          .single()

        if (error || !token) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "disconnected",
                message: "No active QB token found. Re-authorize at /api/qb/authorize",
              }, null, 2)
            }]
          }
        }

        const now = new Date()
        const accessExpiry = new Date(token.access_token_expires_at)
        const refreshExpiry = new Date(token.refresh_token_expires_at)
        const refreshDaysRemaining = Math.floor((refreshExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

        const output = {
          status: refreshDaysRemaining > 0 ? "connected" : "expired",
          access_token: {
            expires_at: accessExpiry.toISOString(),
            valid: accessExpiry > now,
            minutes_remaining: Math.max(0, Math.floor((accessExpiry.getTime() - now.getTime()) / (1000 * 60))),
          },
          refresh_token: {
            expires_at: refreshExpiry.toISOString(),
            valid: refreshExpiry > now,
            days_remaining: refreshDaysRemaining,
            warning: refreshDaysRemaining < 14 ? "⚠️ Refresh token expiring soon! Re-authorize before it expires." : null,
          },
          last_refreshed: token.updated_at,
          realm_id: realmId,
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error checking token status: ${(err as Error).message}` }] }
      }
    }
  )
}
