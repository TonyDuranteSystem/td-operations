/**
 * POST /api/qb/create-invoice
 *
 * Pushes an invoice to QuickBooks from CRM payment data.
 * QB is one-way downstream; our system is the source of truth for invoice
 * numbers. The `invoice_number` (INV-NNNNNN format) is REQUIRED.
 *
 * Body:
 * {
 *   "payment_id": "uuid",            // Supabase payment ID (optional, for linking)
 *   "invoice_number": "INV-002145",  // REQUIRED — our canonical number, used as QB DocNumber
 *   "customer_name": "Company LLC",  // Required
 *   "customer_email": "a@b.com",     // Optional
 *   "line_items": [
 *     { "description": "Tax Return 2024", "amount": 500, "quantity": 1 }
 *   ],
 *   "due_date": "2026-04-15",        // Optional, YYYY-MM-DD
 *   "memo": "Invoice for Q1 2026"    // Optional
 * }
 */

/* eslint-disable no-console -- API route diagnostic logging */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createInvoice } from '@/lib/quickbooks'

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

    if (!body.invoice_number || typeof body.invoice_number !== 'string') {
      return NextResponse.json(
        { error: 'invoice_number is required (string) — QB is one-way downstream, caller must provide our canonical number' },
        { status: 400 }
      )
    }

    if (!body.line_items || !Array.isArray(body.line_items) || body.line_items.length === 0) {
      return NextResponse.json(
        { error: 'line_items array is required and must not be empty' },
        { status: 400 }
      )
    }

    // Validate each line item
    for (const item of body.line_items) {
      if (!item.description || typeof item.amount !== 'number') {
        return NextResponse.json(
          { error: 'Each line_item must have a description (string) and amount (number)' },
          { status: 400 }
        )
      }
    }

    console.log(`[QB Invoice] Creating invoice for "${body.customer_name}" with ${body.line_items.length} items`)

    // Create the invoice in QuickBooks
    const result = await createInvoice({
      customerName: body.customer_name,
      customerEmail: body.customer_email,
      lineItems: body.line_items,
      dueDate: body.due_date,
      memo: body.memo,
      invoiceNumber: body.invoice_number,
    })

    const invoiceId = result.Invoice?.Id
    const invoiceNumber = result.Invoice?.DocNumber
    const totalAmount = result.Invoice?.TotalAmt

    console.log(`[QB Invoice] Created: #${invoiceNumber} (ID: ${invoiceId}), Total: $${totalAmount}`)

    // If a payment_id was provided, link the QB invoice to the CRM payment
    if (body.payment_id) {
      try {
        const supabaseAdmin = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // eslint-disable-next-line no-restricted-syntax -- post-QB-create CRM link update; tracked by dev_task 7ebb1e0c
        await supabaseAdmin
          .from('payments')
          .update({
            qb_invoice_id: invoiceId,
            qb_invoice_number: invoiceNumber,
            notes: `QB Invoice #${invoiceNumber} created`,
          })
          .eq('id', body.payment_id)

        console.log(`[QB Invoice] Linked to CRM payment: ${body.payment_id}`)
      } catch (linkError) {
        // Don't fail the whole request if linking fails
        console.warn('[QB Invoice] Failed to link to CRM payment:', linkError)
      }
    }

    return NextResponse.json({
      success: true,
      invoice: {
        id: invoiceId,
        number: invoiceNumber,
        total: totalAmount,
        customer: body.customer_name,
        status: result.Invoice?.Balance > 0 ? 'unpaid' : 'paid',
      },
    })

  } catch (err) {
    console.error('[QB Invoice] Error:', err)
    return NextResponse.json(
      { error: 'Failed to create invoice', details: String(err) },
      { status: 500 }
    )
  }
}
