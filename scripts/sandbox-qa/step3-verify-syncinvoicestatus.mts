/**
 * Sandbox QA — Step 3 verification.
 * Exercises syncInvoiceStatus('payment', ...) directly against a sandbox draft
 * to prove the helper flips both `payments` AND `client_expenses` for a TD invoice.
 * Reverts state at the end so sandbox stays consistent.
 *
 * Sandbox-only: aborts if NEXT_PUBLIC_SUPABASE_URL is not the sandbox ref.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

const PAYMENT_ID = 'c412facf-c624-4d23-bbab-8579e312a95e'

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  console.log('=== BEFORE ===')
  const { data: payBefore } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, invoice_status, status, paid_date, amount_paid')
    .eq('id', PAYMENT_ID)
    .single()
  const { data: expBefore } = await supabaseAdmin
    .from('client_expenses')
    .select('id, invoice_number, status, paid_date')
    .eq('td_payment_id', PAYMENT_ID)
    .single()
  console.log('payments:', JSON.stringify(payBefore))
  console.log('client_expenses:', JSON.stringify(expBefore))

  if (payBefore?.invoice_status !== 'Draft') {
    console.warn('WARNING: not in Draft state. Resetting to Draft first for clean test.')
    await supabaseAdmin
      .from('payments')
      .update({ invoice_status: 'Draft', status: 'Pending', paid_date: null, amount_paid: 0 })
      .eq('id', PAYMENT_ID)
    await supabaseAdmin
      .from('client_expenses')
      .update({ status: 'Pending', paid_date: null })
      .eq('td_payment_id', PAYMENT_ID)
  }

  console.log('\n=== CALLING syncInvoiceStatus("payment", ..., "Paid", ...) ===')
  const { syncInvoiceStatus } = await import('../../lib/portal/unified-invoice')
  const result = await syncInvoiceStatus('payment', PAYMENT_ID, 'Paid', '2026-05-04', 2500)
  console.log('result:', JSON.stringify(result))

  console.log('\n=== AFTER ===')
  const { data: payAfter } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, invoice_status, status, paid_date, amount_paid')
    .eq('id', PAYMENT_ID)
    .single()
  const { data: expAfter } = await supabaseAdmin
    .from('client_expenses')
    .select('id, invoice_number, status, paid_date')
    .eq('td_payment_id', PAYMENT_ID)
    .single()
  console.log('payments:', JSON.stringify(payAfter))
  console.log('client_expenses:', JSON.stringify(expAfter))

  console.log('\n=== ASSERTIONS ===')
  const payOK =
    payAfter?.invoice_status === 'Paid' &&
    payAfter?.status === 'Paid' &&
    payAfter?.paid_date === '2026-05-04'
  const expOK = expAfter?.status === 'Paid'
  console.log('payments flipped Paid + paid_date set:', payOK ? 'PASS' : 'FAIL')
  console.log('client_expenses mirror flipped Paid:', expOK ? 'PASS' : 'FAIL')

  console.log('\n=== REVERTING ===')
  await supabaseAdmin
    .from('payments')
    .update({
      invoice_status: 'Draft',
      status: 'Pending',
      paid_date: null,
      amount_paid: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', PAYMENT_ID)
  await supabaseAdmin
    .from('client_expenses')
    .update({
      status: 'Pending',
      paid_date: null,
      updated_at: new Date().toISOString(),
    })
    .eq('td_payment_id', PAYMENT_ID)
  const { data: payRevert } = await supabaseAdmin
    .from('payments')
    .select('invoice_status, status, paid_date')
    .eq('id', PAYMENT_ID)
    .single()
  const { data: expRevert } = await supabaseAdmin
    .from('client_expenses')
    .select('status, paid_date')
    .eq('td_payment_id', PAYMENT_ID)
    .single()
  console.log('payments reverted:', JSON.stringify(payRevert))
  console.log('client_expenses reverted:', JSON.stringify(expRevert))

  process.exit(payOK && expOK ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
