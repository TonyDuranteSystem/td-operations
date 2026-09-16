import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { generateInvoiceNumber } = await import('../../lib/portal/invoice-number')
  const num = await generateInvoiceNumber()
  const messageWithBreaks =
    'Please transfer to:\nBank: Sandbox Test Credit Union\nAccount: 000111222333\nRouting: 999888777\n\nReference the invoice number in the memo line so it can be matched quickly.'
  const { data: inv, error: invErr } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: '423f0dd7-8639-4873-88ba-1653a4cf086b',
      description: `QA-PDFBILL fixture — multi-line note ${Date.now()}`,
      amount: 500, amount_currency: 'USD', status: 'Pending',
      invoice_number: num, invoice_status: 'Sent',
      issue_date: new Date().toISOString().slice(0, 10),
      subtotal: 500, discount: 0, total: 500,
      amount_due: 500, amount_paid: 0, is_test: true,
      message: messageWithBreaks,
    })
    .select('id, invoice_number').single()
  if (invErr || !inv) throw new Error(`insert failed: ${invErr?.message}`)
  console.log('Standalone PDF-overlap fixture invoice:', JSON.stringify(inv))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
