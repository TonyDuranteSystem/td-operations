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
  const regErrors: string[] = []

  // ═══════════════════════════════════════
  // qb_list_invoices
  // ═══════════════════════════════════════
  server.tool(
    "qb_list_invoices",
    "List invoices from QuickBooks Online. Filter by customer name, status (Open/Paid/Overdue), or date range. Returns invoice number, customer, amount, balance due, due date, and status. Also shows aggregate totals. For CRM payment data, use crm_search_payments instead.",
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

        // Note: QB Query Language doesn't support CustomerRef.name for Invoice
        // Filter by customer name in memory after fetching results

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

        // Filter by customer name in memory (QB Query doesn't support CustomerRef.name on Invoice)
        if (customer_name) {
          const search = customer_name.toLowerCase()
          invoices = invoices.filter((inv: Record<string, unknown>) => {
            const name = ((inv.CustomerRef as Record<string, unknown>)?.name as string) || ""
            return name.toLowerCase().includes(search)
          })
        }

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
    "Search QuickBooks Online customers by name, email, or company. Returns customer ID, display name, email, phone, balance, currency, and active status. For CRM contacts, use crm_search_contacts instead — QuickBooks customers are for invoicing only.",
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
    "List payments received in QuickBooks Online. Filter by customer name or date range. Returns payment amount, date, method, memo, and unapplied amount. Also shows aggregate total received. For CRM payment records, use crm_search_payments instead.",
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

        // Note: QB Query Language doesn't support CustomerRef.name for Payment
        // Filter by customer name in memory after fetching results
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

        let payments = result.QueryResponse?.Payment || []

        // Filter by customer name in memory
        if (customer_name) {
          const search = customer_name.toLowerCase()
          payments = payments.filter((p: Record<string, unknown>) => {
            const name = ((p.CustomerRef as Record<string, unknown>)?.name as string) || ""
            return name.toLowerCase().includes(search)
          })
        }

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
    "Get QuickBooks company info (name, country, fiscal year, email, phone) and OAuth2 connection health (access/refresh token expiry and remaining time). Use this to verify QuickBooks is connected before running other qb_* tools.",
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
    "Create a new invoice in QuickBooks Online. Automatically finds the customer by name or creates a new QB customer if not found. Provide line items with description, amount, and optional quantity. Returns the created invoice with ID, doc number, and total. Use qb_search_customers first to verify the customer name.",
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
  // qb_void_invoice
  // ═══════════════════════════════════════
  try {
  server.tool(
    "qb_void_invoice",
    "Void or delete an invoice in QuickBooks Online. Void (recommended) keeps the invoice in history but zeroes the balance. Delete removes it completely. Requires the invoice ID (from qb_list_invoices). Use this to cancel incorrect or duplicate invoices.",
    {
      invoice_id: z.string().describe("QuickBooks Invoice ID (the 'id' field from qb_list_invoices, NOT the doc_number)"),
      action: z.enum(["void", "delete"]).optional().default("void").describe("'void' (recommended — keeps history) or 'delete' (permanent removal)"),
    },
    async ({ invoice_id, action }) => {
      try {
        // First, get the invoice to retrieve SyncToken
        const invoice = await qbApiCall(`/invoice/${invoice_id}`)
        const inv = invoice.Invoice

        if (!inv) {
          return {
            content: [{ type: "text" as const, text: `❌ Invoice ID ${invoice_id} not found in QuickBooks` }]
          }
        }

        const result = await qbApiCall(`/invoice?operation=${action}`, {
          method: "POST",
          body: {
            Id: inv.Id,
            SyncToken: inv.SyncToken,
          },
        })

        const updated = result.Invoice
        return {
          content: [{
            type: "text" as const,
            text: `✅ Invoice #${inv.DocNumber} (${(inv.CustomerRef as Record<string, unknown>)?.name}) — ${action === "void" ? "VOIDED" : "DELETED"} successfully\nOriginal amount: $${inv.TotalAmt}\nNew balance: $${updated?.Balance ?? 0}`,
          }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error ${action}ing invoice: ${(err as Error).message}` }] }
      }
    }
  )
  } catch (e) { regErrors.push(`qb_void_invoice: ${(e as Error).message}`) }

  // ═══════════════════════════════════════
  // qb_get_invoice
  // ═══════════════════════════════════════
  try {
  server.tool(
    "qb_get_invoice",
    "Get full details of a single QuickBooks invoice by ID. Returns ALL fields: line items, customer memo, footer, custom fields, email status, payment info, tax details. Use this to inspect invoices before sending or to check payment instructions. Use qb_list_invoices first to find the invoice ID.",
    {
      invoice_id: z.string().describe("QuickBooks Invoice ID (the 'id' field from qb_list_invoices)"),
    },
    async ({ invoice_id }) => {
      try {
        const result = await qbApiCall(`/invoice/${invoice_id}`)
        const inv = result.Invoice

        if (!inv) {
          return { content: [{ type: "text" as const, text: `❌ Invoice ID ${invoice_id} not found` }] }
        }

        // Extract all relevant fields
        const output = {
          id: inv.Id,
          doc_number: inv.DocNumber,
          sync_token: inv.SyncToken,
          customer: {
            id: inv.CustomerRef?.value,
            name: inv.CustomerRef?.name,
          },
          dates: {
            txn_date: inv.TxnDate,
            due_date: inv.DueDate,
            ship_date: inv.ShipDate,
          },
          amounts: {
            total: inv.TotalAmt,
            balance: inv.Balance,
            home_total: inv.HomeTotalAmt,
            home_balance: inv.HomeBalance,
            deposit: inv.Deposit,
          },
          currency: inv.CurrencyRef?.value || "USD",
          exchange_rate: inv.ExchangeRate,
          email: {
            status: inv.EmailStatus,
            bill_email: inv.BillEmail?.Address,
            bill_email_cc: inv.BillEmailCc?.Address,
            bill_email_bcc: inv.BillEmailBcc?.Address,
          },
          addresses: {
            billing: inv.BillAddr ? {
              line1: inv.BillAddr.Line1,
              city: inv.BillAddr.City,
              state: inv.BillAddr.CountrySubDivisionCode,
              postal: inv.BillAddr.PostalCode,
              country: inv.BillAddr.Country,
            } : null,
            shipping: inv.ShipAddr ? {
              line1: inv.ShipAddr.Line1,
              city: inv.ShipAddr.City,
              state: inv.ShipAddr.CountrySubDivisionCode,
              postal: inv.ShipAddr.PostalCode,
              country: inv.ShipAddr.Country,
            } : null,
          },
          line_items: (inv.Line || [])
            .filter((l: Record<string, unknown>) => l.DetailType !== "SubTotalLineDetail")
            .map((l: Record<string, unknown>) => ({
              id: l.Id,
              description: l.Description,
              amount: l.Amount,
              detail_type: l.DetailType,
              ...(l.SalesItemLineDetail ? {
                qty: (l.SalesItemLineDetail as Record<string, unknown>).Qty,
                unit_price: (l.SalesItemLineDetail as Record<string, unknown>).UnitPrice,
                item: ((l.SalesItemLineDetail as Record<string, unknown>).ItemRef as Record<string, unknown>)?.name,
              } : {}),
            })),
          customer_memo: inv.CustomerMemo?.value || null,
          private_note: inv.PrivateNote || null,
          footer: inv.PrintStatus === "NeedToPrint" ? "(needs printing)" : null,
          custom_fields: inv.CustomField?.filter((f: Record<string, unknown>) => f.StringValue) || [],
          tax: inv.TxnTaxDetail ? {
            total_tax: inv.TxnTaxDetail.TotalTax,
            lines: inv.TxnTaxDetail.TaxLine,
          } : null,
          payment_method: inv.PaymentMethodRef?.name || null,
          deposit_to_account: inv.DepositToAccountRef?.name || null,
          print_status: inv.PrintStatus,
          apply_tax_after_discount: inv.ApplyTaxAfterDiscount,
          allow_online_payment: inv.AllowOnlinePayment,
          allow_online_credit_card: inv.AllowOnlineCreditCardPayment,
          allow_online_ach: inv.AllowOnlineACHPayment,
          status: inv.Balance === 0
            ? "Paid"
            : new Date(inv.DueDate) < new Date()
              ? "Overdue"
              : "Open",
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error getting invoice: ${(err as Error).message}` }] }
      }
    }
  )
  } catch (e) { regErrors.push(`qb_get_invoice: ${(e as Error).message}`) }

  // ═══════════════════════════════════════
  // qb_send_invoice
  // ═══════════════════════════════════════
  try {
  server.tool(
    "qb_send_invoice",
    "Send an invoice via email using Postmark. Downloads the invoice PDF from QuickBooks and sends it as an email attachment with bank payment details (USD or EUR based on invoice currency). The customer receives a professional bilingual email from support@tonydurante.us. WORKFLOW: qb_create_invoice → qb_get_invoice (review) → qb_update_invoice (if needed) → CONFIRM with user → qb_send_invoice. Use email_get_delivery_status with the returned MessageID to track delivery.",
    {
      invoice_id: z.string().describe("QuickBooks Invoice ID to send"),
      email_to: z.string().describe("Recipient email address"),
      language: z.enum(["en", "it"]).optional().default("en").describe("Email language: 'en' (default) or 'it' for Italian"),
    },
    async ({ invoice_id, email_to, language }) => {
      try {
        // 1. Get invoice details from QB
        const invResult = await qbApiCall(`/invoice/${invoice_id}`)
        const inv = invResult.Invoice
        if (!inv) {
          return { content: [{ type: "text" as const, text: `❌ Invoice ${invoice_id} not found` }] }
        }

        // 2. Download invoice PDF from QB
        const accessToken = await getActiveToken()
        const realmId = process.env.QB_REALM_ID!
        const pdfRes = await fetch(
          `https://quickbooks.api.intuit.com/v3/company/${realmId}/invoice/${invoice_id}/pdf`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/pdf",
            },
          }
        )
        if (!pdfRes.ok) throw new Error(`PDF download failed: ${pdfRes.status}`)
        const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())
        const pdfBase64 = pdfBuffer.toString("base64")

        // 3. Bank details based on invoice currency
        const currency = (inv.CurrencyRef?.value as string) || "USD"
        const bankSection =
          currency === "EUR"
            ? "Banca: Banking Circle (via Wise)\nIBAN: DK8989000023658198\nBIC/SWIFT: SXPYDKKK\nBeneficiario: Tony Durante LLC"
            : "Bank: Relay Financial\nRouting Number: 064208588\nAccount Number: 200000306770\nBeneficiary: Tony Durante LLC"

        // 4. Build email content
        const customerName = (inv.CustomerRef?.name as string) || "Customer"
        const docNumber = inv.DocNumber || inv.Id
        const total = inv.TotalAmt
        const dueDate = inv.DueDate

        const subject =
          language === "it"
            ? `Fattura #${docNumber} — Tony Durante LLC`
            : `Invoice #${docNumber} — Tony Durante LLC`

        const htmlBody =
          language === "it"
            ? `<p>Gentile ${customerName},</p>
<p>In allegato trova la fattura <strong>#${docNumber}</strong> per un importo di <strong>${currency} ${total}</strong>.</p>
<p><strong>Scadenza:</strong> ${dueDate}</p>
<p><strong>Modalità di pagamento — Bonifico bancario:</strong></p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;">${bankSection}</pre>
<p>Causale: Invoice #${docNumber}</p>
<p>Per qualsiasi domanda, non esiti a contattarci.</p>
<p>Cordiali saluti,<br><strong>Tony Durante LLC</strong><br>support@tonydurante.us</p>`
            : `<p>Dear ${customerName},</p>
<p>Please find attached invoice <strong>#${docNumber}</strong> for <strong>${currency} ${total}</strong>.</p>
<p><strong>Due date:</strong> ${dueDate}</p>
<p><strong>Payment method — Wire Transfer:</strong></p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;">${bankSection}</pre>
<p>Reference: Invoice #${docNumber}</p>
<p>If you have any questions, please don't hesitate to reach out.</p>
<p>Best regards,<br><strong>Tony Durante LLC</strong><br>support@tonydurante.us</p>`

        // 5. Send via Postmark with PDF attachment
        const postmarkToken = process.env.POSTMARK_SERVER_TOKEN
        if (!postmarkToken) throw new Error("POSTMARK_SERVER_TOKEN not configured")

        const emailRes = await fetch("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": postmarkToken,
          },
          body: JSON.stringify({
            From: "support@tonydurante.us",
            To: email_to,
            Subject: subject,
            HtmlBody: htmlBody,
            Tag: "invoice",
            TrackOpens: true,
            TrackLinks: "HtmlAndText",
            Attachments: [
              {
                Name: `Invoice-${docNumber}.pdf`,
                Content: pdfBase64,
                ContentType: "application/pdf",
              },
            ],
          }),
        })

        if (!emailRes.ok) {
          const err = await emailRes.json().catch(() => ({}))
          throw new Error(`Postmark error ${emailRes.status}: ${(err as Record<string, string>).Message || emailRes.statusText}`)
        }

        const emailData = await emailRes.json()

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Invoice #${docNumber} sent to ${email_to}\nCustomer: ${customerName}\nTotal: ${currency} ${total}\nDue: ${dueDate}\nPostmark MessageID: ${emailData.MessageID}\nUse email_get_delivery_status('${emailData.MessageID}') to track.`,
            },
          ],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error sending invoice: ${(err as Error).message}` }] }
      }
    }
  )
  } catch (e) { regErrors.push(`qb_send_invoice: ${(e as Error).message}`) }

  // ═══════════════════════════════════════
  // qb_update_invoice
  // ═══════════════════════════════════════
  try {
  server.tool(
    "qb_update_invoice",
    "Update an existing QuickBooks invoice. Can modify customer memo (payment instructions visible to customer), private note, due date, or email address. Use qb_get_invoice first to review current values. Requires a sparse update — only provided fields are changed, all others remain.",
    {
      invoice_id: z.string().describe("QuickBooks Invoice ID to update"),
      customer_memo: z.string().optional().describe("Message visible to customer on the invoice (e.g., bank details, payment instructions)"),
      private_note: z.string().optional().describe("Internal note (not visible to customer)"),
      due_date: z.string().optional().describe("New due date (YYYY-MM-DD)"),
      bill_email: z.string().optional().describe("Update customer email address for this invoice"),
    },
    async ({ invoice_id, customer_memo, private_note, due_date, bill_email }) => {
      try {
        // First, get the current invoice for SyncToken and existing data
        const current = await qbApiCall(`/invoice/${invoice_id}`)
        const inv = current.Invoice

        if (!inv) {
          return { content: [{ type: "text" as const, text: `❌ Invoice ID ${invoice_id} not found` }] }
        }

        // Build sparse update — QB requires Id, SyncToken, and changed fields
        const update: Record<string, unknown> = {
          Id: inv.Id,
          SyncToken: inv.SyncToken,
          sparse: true,
        }

        if (customer_memo !== undefined) {
          update.CustomerMemo = { value: customer_memo }
        }
        if (private_note !== undefined) {
          update.PrivateNote = private_note
        }
        if (due_date !== undefined) {
          update.DueDate = due_date
        }
        if (bill_email !== undefined) {
          update.BillEmail = { Address: bill_email }
        }

        const result = await qbApiCall(`/invoice`, {
          method: "POST",
          body: update,
        })

        const updated = result.Invoice
        const changes: string[] = []
        if (customer_memo !== undefined) changes.push("customer memo")
        if (private_note !== undefined) changes.push("private note")
        if (due_date !== undefined) changes.push("due date")
        if (bill_email !== undefined) changes.push("bill email")

        return {
          content: [{
            type: "text" as const,
            text: `✅ Invoice #${updated.DocNumber} updated — changed: ${changes.join(", ")}\nCustomer: ${updated.CustomerRef?.name}\nMemo: ${updated.CustomerMemo?.value || "(none)"}`,
          }]
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error updating invoice: ${(err as Error).message}` }] }
      }
    }
  )
  } catch (e) { regErrors.push(`qb_update_invoice: ${(e as Error).message}`) }

  // ═══════════════════════════════════════
  // qb_token_status
  // ═══════════════════════════════════════
  server.tool(
    "qb_token_status",
    "Check QuickBooks OAuth2 token health. Returns access token validity (minutes remaining), refresh token validity (days remaining), and warnings if refresh token is expiring soon. If status is 'disconnected', re-authorize at /api/qb/authorize.",
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

  // Temporary debug tool — remove after fixing registration issue
  if (regErrors.length > 0) {
    console.error("[QB] Registration errors:", regErrors)
  }
  console.log(`[QB] Registration complete. Errors: ${regErrors.length}`)

  server.tool(
    "qb_debug_registration",
    "Debug: shows QB tool registration errors",
    {},
    async () => ({
      content: [{ type: "text" as const, text: regErrors.length > 0
        ? `Registration errors:\n${regErrors.join("\n")}`
        : "All QB tools registered successfully" }]
    })
  )
}
