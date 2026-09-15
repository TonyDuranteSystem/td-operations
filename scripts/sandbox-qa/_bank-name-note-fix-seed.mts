import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
const TD_ENTITY_ID = '00000000-0000-0000-0000-000000000001'
const ACME_ID = 'a98e41ab-6f1e-4ef0-bb2d-37797b11fbed' // Acme Holdings LLC, is_test fixture account

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { generateInvoiceNumber } = await import('../../lib/portal/invoice-number')
  const today = new Date().toISOString().slice(0, 10)

  // A My Finances transaction, NOT yet sent to Finance — used to click the real
  // "send to Finance" button and verify the bank name survives onto the new row.
  const { data: tx, error: txErr } = await supabaseAdmin
    .from('td_books_transactions')
    .insert({
      entity_id: TD_ENTITY_ID,
      transaction_date: today,
      amount: 42,
      currency: 'USD',
      description: 'QA-BANKNAMEFIX fixture — Zelle from a named bank',
      counterparty: 'QA BANKNAMEFIX SENDER',
      bank_name: 'QA Test Credit Union checking 9999',
      account_type: 'checking',
      category: 'uncategorized',
      tax_year: new Date(today).getFullYear(),
      transaction_ref: `qa-banknamefix-${Date.now()}`,
    })
    .select('id')
    .single()
  console.log('TX (native, not yet sent):', JSON.stringify({ data: tx, error: txErr }))

  // A genuinely Paid invoice with no transaction ever linked to it, to link the
  // note against — same shape as the real Beril case.
  const num = await generateInvoiceNumber()
  const { data: inv, error: invErr } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: ACME_ID,
      description: 'QA-BANKNAMEFIX fixture — already-Paid invoice',
      amount: 42, amount_currency: 'USD', status: 'Paid',
      invoice_number: num, invoice_status: 'Paid',
      issue_date: today, subtotal: 42, discount: 0, total: 42,
      amount_due: 0, amount_paid: 42, is_test: false,
    })
    .select('id, invoice_number').single()
  console.log('Invoice (plain Paid):', JSON.stringify({ data: inv, error: invErr }))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
