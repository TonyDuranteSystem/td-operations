import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

const ACCOUNT_ID = '30c2cd96-03e4-43cf-9536-81d961b18b1d' // Uxio Test LLC (is_test=true)
const TOTAL = 1000
const APPLIED = 400 // leaves $600 due — genuine partial state

async function main() {
  const { createTDInvoice } = await import('../../lib/portal/td-invoice')
  const { applyMoneyToInvoice } = await import('../../lib/finance/apply-payment')
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  const surfaces = [
    'QA PARTIAL TEST — Finance tab Mark Paid',
    'QA PARTIAL TEST — Account page Mark Paid',
    'QA PARTIAL TEST — Old payment board Mark Paid',
  ]

  const results: Array<{ paymentId: string; invoiceNumber: string; surface: string }> = []

  for (const desc of surfaces) {
    const created = await createTDInvoice({
      account_id: ACCOUNT_ID,
      line_items: [{ description: desc, unit_price: TOTAL }],
      description: desc,
    })
    console.log(`Created ${created.invoiceNumber} (${created.paymentId}) status=${created.status}`)

    const applied = await applyMoneyToInvoice({
      paymentId: created.paymentId,
      mode: 'apply',
      appliedAmount: APPLIED,
      paidDate: new Date().toISOString().split('T')[0],
      actor: 'qa-test-script',
      paymentMethod: 'Test',
    })
    console.log(`  applied: ${JSON.stringify(applied)}`)

    results.push({ paymentId: created.paymentId, invoiceNumber: created.invoiceNumber, surface: desc })
  }

  console.log('\n=== VERIFY FINAL STATE ===')
  for (const r of results) {
    const { data } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, invoice_status, status, total, amount_paid, amount_due')
      .eq('id', r.paymentId)
      .single()
    console.log(`${r.surface}: ${JSON.stringify(data)}`)
  }

  console.log('\n=== TEST INVOICE IDS (for reference) ===')
  console.log(JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
