/**
 * GET /api/qb/invoice-pdf?invoice_id=123
 * POST /api/qb/invoice-pdf (with body)
 *
 * Generates a branded PDF invoice for Tony Durante LLC.
 *
 * GET mode: Fetches invoice data from QuickBooks by invoice ID
 * POST mode: Accepts custom invoice data in the request body
 *
 * Returns: application/pdf binary
 */

import { NextRequest, NextResponse } from 'next/server'
import { generateInvoicePDF, type InvoiceData } from '@/lib/invoice-pdf'
import { qbApiCall } from '@/lib/quickbooks'

/**
 * GET — Generate PDF from existing QB invoice
 */
export async function GET(request: NextRequest) {
  const invoiceId = request.nextUrl.searchParams.get('invoice_id')

  if (!invoiceId) {
    return NextResponse.json(
      { error: 'invoice_id query parameter is required' },
      { status: 400 }
    )
  }

  try {
    // Fetch invoice from QuickBooks
    const result = await qbApiCall(`/invoice/${invoiceId}`)
    const inv = result.Invoice

    if (!inv) {
      return NextResponse.json(
        { error: `Invoice ${invoiceId} not found in QuickBooks` },
        { status: 404 }
      )
    }

    // Map QB invoice to our format
    const invoiceData: InvoiceData = {
      invoiceNumber: inv.DocNumber || `TD-${inv.Id}`,
      date: inv.TxnDate,
      dueDate: inv.DueDate || inv.TxnDate,
      customerName: inv.CustomerRef?.name || 'Unknown Customer',
      customerEmail: inv.BillEmail?.Address,
      lineItems: (inv.Line || [])
        .filter((line: Record<string, unknown>) => line.DetailType === 'SalesItemLineDetail')
        .map((line: Record<string, unknown>) => ({
          description: line.Description || 'Service',
          amount: (line.SalesItemLineDetail as Record<string, unknown>)?.UnitPrice as number || line.Amount as number || 0,
          quantity: (line.SalesItemLineDetail as Record<string, unknown>)?.Qty as number || 1,
        })),
      terms: inv.SalesTermRef?.name || 'Net 30',
      memo: inv.PrivateNote || inv.CustomerMemo?.value,
    }

    const pdfBuffer = await generateInvoicePDF(invoiceData)

    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Invoice-${invoiceData.invoiceNumber}.pdf"`,
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err) {
    console.error('[Invoice PDF] Error:', err)
    return NextResponse.json(
      { error: 'Failed to generate invoice PDF', details: String(err) },
      { status: 500 }
    )
  }
}

/**
 * POST — Generate PDF from custom data
 *
 * Body: {
 *   invoice_number: "TD-001",
 *   date: "2026-03-05",
 *   due_date: "2026-04-05",
 *   customer_name: "Acme Corp",
 *   customer_email: "client@acme.com",
 *   customer_address: "123 Main St, Tampa, FL",
 *   line_items: [
 *     { description: "Tax Return 2025", amount: 500, quantity: 1 }
 *   ],
 *   terms: "Net 30",
 *   notes: "Thank you!"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Validate required fields
    if (!body.customer_name) {
      return NextResponse.json(
        { error: 'customer_name is required' },
        { status: 400 }
      )
    }

    if (!body.line_items?.length) {
      return NextResponse.json(
        { error: 'line_items array is required' },
        { status: 400 }
      )
    }

    const today = new Date().toISOString().split('T')[0]

    const invoiceData: InvoiceData = {
      invoiceNumber: body.invoice_number || `TD-${Date.now().toString().slice(-6)}`,
      date: body.date || today,
      dueDate: body.due_date || today,
      customerName: body.customer_name,
      customerEmail: body.customer_email,
      customerAddress: body.customer_address,
      lineItems: body.line_items.map((item: Record<string, unknown>) => ({
        description: item.description as string || 'Service',
        amount: item.amount as number || 0,
        quantity: item.quantity as number || 1,
      })),
      terms: body.terms || 'Net 30',
      notes: body.notes,
      memo: body.memo,
    }

    const pdfBuffer = await generateInvoicePDF(invoiceData)

    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Invoice-${invoiceData.invoiceNumber}.pdf"`,
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err) {
    console.error('[Invoice PDF] Error:', err)
    return NextResponse.json(
      { error: 'Failed to generate invoice PDF', details: String(err) },
      { status: 500 }
    )
  }
}
