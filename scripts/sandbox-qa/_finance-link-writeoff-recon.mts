import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  const { data: uxio } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, is_test')
    .ilike('company_name', '%Uxio Test%')
    .maybeSingle()
  console.log('Uxio Test LLC:', JSON.stringify(uxio))

  const { data: legacyLinked, count } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, portal_invoice_id', { count: 'exact' })
    .not('portal_invoice_id', 'is', null)
    .limit(5)
  console.log('payments with portal_invoice_id set:', count, JSON.stringify(legacyLinked))

  const { data: openInvoices, count: openCount } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, account_id, total, amount_due, invoice_status', { count: 'exact' })
    .eq('account_id', uxio?.id)
    .limit(10)
  console.log(`Uxio Test LLC payments (${openCount} total):`, JSON.stringify(openInvoices))

  const { data: existingTx } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, description')
    .ilike('description', '%QA-LINKWRITEOFF%')
    .limit(5)
  console.log('existing QA fixture books transactions:', JSON.stringify(existingTx))

  const { data: existingFeeds } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('id, source, memo, status')
    .ilike('memo', '%QA-LINKWRITEOFF%')
    .limit(5)
  console.log('existing QA fixture feed rows:', JSON.stringify(existingFeeds))
}
main()
