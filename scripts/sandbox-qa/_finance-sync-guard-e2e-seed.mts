import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
const UXIO_ID = '30c2cd96-03e4-43cf-9536-81d961b18b1d'

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { generateInvoiceNumber } = await import('../../lib/portal/invoice-number')
  const today = new Date().toISOString().slice(0, 10)

  // Single-line invoice — target for the single-line write-off scenario.
  const num1 = await generateInvoiceNumber()
  const { data: inv1, error: inv1Err } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: UXIO_ID,
      description: 'QA-SYNCGUARD-E2E single-line write-off target',
      amount: 400,
      amount_currency: 'USD',
      status: 'Pending',
      invoice_number: num1,
      invoice_status: 'Sent',
      issue_date: today,
      subtotal: 400,
      discount: 0,
      total: 400,
      amount_due: 400,
      amount_paid: 0,
      is_test: true,
    })
    .select('id, invoice_number')
    .single()
  console.log('Invoice 1 (single-line):', JSON.stringify({ data: inv1, error: inv1Err }))
  if (inv1) {
    await supabaseAdmin.from('payment_items').insert([
      { payment_id: inv1.id, description: 'QA line 1', quantity: 1, unit_price: 400, amount: 400, sort_order: 0 },
    ])
  }

  // Multi-line invoice — target for the CRITICAL multi-line write-off check.
  const num2 = await generateInvoiceNumber()
  const { data: inv2, error: inv2Err } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: UXIO_ID,
      description: 'QA-SYNCGUARD-E2E multi-line write-off target',
      amount: 400,
      amount_currency: 'USD',
      status: 'Pending',
      invoice_number: num2,
      invoice_status: 'Sent',
      issue_date: today,
      subtotal: 400,
      discount: 0,
      total: 400,
      amount_due: 400,
      amount_paid: 0,
      is_test: true,
    })
    .select('id, invoice_number')
    .single()
  console.log('Invoice 2 (multi-line):', JSON.stringify({ data: inv2, error: inv2Err }))
  if (inv2) {
    await supabaseAdmin.from('payment_items').insert([
      { payment_id: inv2.id, description: 'QA line A', quantity: 1, unit_price: 250, amount: 250, sort_order: 0 },
      { payment_id: inv2.id, description: 'QA line B', quantity: 1, unit_price: 150, amount: 150, sort_order: 1 },
    ])
  }

  // Plain partial-payment target — a small, real Uxio invoice already open.
  console.log('Plain-partial target: use existing INV-002578 ($10, Sent) found in recon.')
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
