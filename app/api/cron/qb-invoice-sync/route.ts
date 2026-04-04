/**
 * QB Invoice Sync — Import all QuickBooks invoices into our system.
 *
 * For each QB invoice:
 * 1. Match QB customer name → CRM account (company_name) or contact (first+last name)
 * 2. Create client_invoices record with QB's invoice number (INV-NNNNNN)
 * 3. Create payments mirror record linked via portal_invoice_id
 *
 * Idempotent: skips invoices that already exist (by invoice_number in client_invoices).
 * Run manually or as a one-time cron.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { qbApiCall } from '@/lib/quickbooks'

// QB invoice status → our status mapping
function mapQBStatus(balance: number, total: number): { invoiceStatus: string; paymentStatus: string } {
  if (total === 0) return { invoiceStatus: 'Paid', paymentStatus: 'Paid' }
  if (balance === 0) return { invoiceStatus: 'Paid', paymentStatus: 'Paid' }
  if (balance < total && balance > 0) return { invoiceStatus: 'Sent', paymentStatus: 'Pending' }
  return { invoiceStatus: 'Sent', paymentStatus: 'Pending' }
}

// Try to match a QB customer name to a CRM account or contact
async function matchCustomerToCRM(customerName: string): Promise<{
  account_id: string | null
  contact_id: string | null
  customer_id: string | null
  match_type: 'account' | 'contact' | 'none'
}> {
  const nameLower = customerName.toLowerCase().trim()

  // 1. Try exact match on accounts.company_name
  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name')
    .not('company_name', 'is', null)

  if (accounts) {
    for (const acct of accounts) {
      if (acct.company_name.toLowerCase().trim() === nameLower) {
        // Find customer_id for this account
        const { data: customer } = await supabaseAdmin
          .from('client_customers')
          .select('id')
          .eq('account_id', acct.id)
          .limit(1)
          .maybeSingle()

        return {
          account_id: acct.id,
          contact_id: null,
          customer_id: customer?.id ?? null,
          match_type: 'account',
        }
      }
    }

    // 2. Try partial match — QB name contains account name or vice versa
    for (const acct of accounts) {
      const acctLower = acct.company_name.toLowerCase().trim()
      if (nameLower.includes(acctLower) || acctLower.includes(nameLower)) {
        const { data: customer } = await supabaseAdmin
          .from('client_customers')
          .select('id')
          .eq('account_id', acct.id)
          .limit(1)
          .maybeSingle()

        return {
          account_id: acct.id,
          contact_id: null,
          customer_id: customer?.id ?? null,
          match_type: 'account',
        }
      }
    }
  }

  // 3. Try matching against contacts (first_name + last_name)
  const { data: contacts } = await supabaseAdmin
    .from('contacts')
    .select('id, first_name, last_name, email')
    .not('first_name', 'is', null)

  if (contacts) {
    for (const contact of contacts) {
      const fullName = `${contact.first_name || ''} ${contact.last_name || ''}`.toLowerCase().trim()
      if (fullName === nameLower || nameLower.includes(fullName) || fullName.includes(nameLower)) {
        const { data: customer } = await supabaseAdmin
          .from('client_customers')
          .select('id')
          .eq('contact_id', contact.id)
          .limit(1)
          .maybeSingle()

        return {
          account_id: null,
          contact_id: contact.id,
          customer_id: customer?.id ?? null,
          match_type: 'contact',
        }
      }
    }
  }

  return { account_id: null, contact_id: null, customer_id: null, match_type: 'none' }
}

export async function GET(req: NextRequest) {
  try {
    // Auth check
    const authHeader = req.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const today = new Date().toISOString().split('T')[0]

    // Fetch ALL QB invoices in date ranges to avoid the 200-item limit
    const dateRanges = [
      { start: '2026-01-01', end: '2026-02-28' },
      { start: '2026-03-01', end: today },
    ]

    const allInvoices: Array<Record<string, unknown>> = []

    for (const range of dateRanges) {
      const query = encodeURIComponent(
        `SELECT * FROM Invoice WHERE TxnDate >= '${range.start}' AND TxnDate <= '${range.end}' ORDERBY DocNumber DESC MAXRESULTS 200`
      )
      const result = await qbApiCall(`/query?query=${query}`)
      const invoices = result.QueryResponse?.Invoice || []
      allInvoices.push(...invoices)
    }

    // Deduplicate by QB Id (in case date ranges overlap)
    const seen = new Set<string>()
    const uniqueInvoices = allInvoices.filter(inv => {
      const id = String(inv.Id)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })

    let imported = 0
    let skipped = 0
    let matchedAccount = 0
    let matchedContact = 0
    let unmatched = 0
    const unmatchedCustomers: string[] = []
    const errors: string[] = []

    for (const inv of uniqueInvoices) {
      try {
        const docNumber = String(inv.DocNumber || '')
        if (!docNumber) { skipped++; continue }

        // Skip if already imported (idempotent check)
        const { data: existing } = await supabaseAdmin
          .from('client_invoices')
          .select('id')
          .eq('invoice_number', docNumber)
          .limit(1)

        if (existing && existing.length > 0) { skipped++; continue }

        const customerName = (inv.CustomerRef as { name?: string })?.name || ''
        const total = Number(inv.TotalAmt || 0)
        const balance = Number(inv.Balance || 0)
        const currency = (inv.CurrencyRef as { value?: string })?.value || 'USD'
        const txnDate = String(inv.TxnDate || today)
        const dueDate = String(inv.DueDate || txnDate)
        const qbId = String(inv.Id)
        const amountPaid = total - balance
        const { invoiceStatus, paymentStatus } = mapQBStatus(balance, total)

        // Match customer to CRM
        const match = await matchCustomerToCRM(customerName)

        if (match.match_type === 'account') matchedAccount++
        else if (match.match_type === 'contact') matchedContact++
        else {
          unmatched++
          if (!unmatchedCustomers.includes(customerName)) {
            unmatchedCustomers.push(customerName)
          }
        }

        // Need at least account_id or contact_id for client_invoices (check constraint)
        if (!match.account_id && !match.contact_id) {
          // Store with a note for manual linking later
          // We still import — just without the CRM link
          // But client_invoices has a CHECK constraint requiring account_id or contact_id
          // So we skip unmatched for now and log them
          continue
        }

        // Build description from line items
        const lines = (inv.Line as Array<Record<string, unknown>> || [])
          .filter(l => l.DetailType === 'SalesItemLineDetail')
        const description = lines
          .map(l => String(l.Description || 'Service'))
          .join('; ') || `QB Invoice ${docNumber}`

        // Create client_invoices record
        const { data: newInvoice, error: invErr } = await supabaseAdmin
          .from('client_invoices')
          .insert({
            account_id: match.account_id,
            contact_id: match.contact_id,
            customer_id: match.customer_id,
            invoice_number: docNumber,
            status: invoiceStatus,
            currency,
            subtotal: total,
            discount: 0,
            tax_total: 0,
            total,
            amount_paid: amountPaid,
            amount_due: balance,
            issue_date: txnDate,
            due_date: dueDate,
            paid_date: balance === 0 && total > 0 ? txnDate : null,
            notes: `Imported from QB (ID: ${qbId}). Customer: ${customerName}`,
          })
          .select('id')
          .single()

        if (invErr) {
          errors.push(`${docNumber}: ${invErr.message}`)
          continue
        }

        // Create single line item
        await supabaseAdmin.from('client_invoice_items').insert({
          invoice_id: newInvoice.id,
          description,
          unit_price: total,
          quantity: 1,
          amount: total,
          sort_order: 0,
        })

        // Create payments mirror
        await supabaseAdmin.from('payments').insert({
          account_id: match.account_id,
          contact_id: match.contact_id,
          portal_invoice_id: newInvoice.id,
          invoice_number: docNumber,
          description,
          amount: total,
          amount_paid: amountPaid,
          amount_due: balance,
          amount_currency: currency,
          subtotal: total,
          discount: 0,
          total,
          status: paymentStatus,
          invoice_status: invoiceStatus,
          issue_date: txnDate,
          due_date: dueDate,
          paid_date: balance === 0 && total > 0 ? txnDate : null,
          payment_type: 'Invoice',
          notes: `QB Invoice ${docNumber} — ${customerName}`,
          qb_invoice_id: qbId,
          qb_sync_status: 'synced',
        })

        imported++
      } catch (err) {
        errors.push(`${inv.DocNumber}: ${(err as Error).message}`)
      }
    }

    const summary = {
      total_qb_invoices: uniqueInvoices.length,
      imported,
      skipped,
      matched_account: matchedAccount,
      matched_contact: matchedContact,
      unmatched,
      unmatched_customers: unmatchedCustomers.slice(0, 30),
      errors: errors.slice(0, 20),
    }

    await supabaseAdmin.from('cron_log').insert({
      endpoint: '/api/cron/qb-invoice-sync',
      status: errors.length > 0 ? 'partial' : 'success',
      details: summary,
      executed_at: new Date().toISOString(),
    })

    return NextResponse.json({ ok: true, ...summary })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[qb-invoice-sync] Error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
