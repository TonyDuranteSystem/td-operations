import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  const { data: inv } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number')
    .eq('invoice_number', 'INV-002579')
  console.log('Invoice found:', JSON.stringify(inv))

  const { data: tx } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, moved_to_feed_id')
    .like('transaction_ref', 'qa-banknamefix-%')
  console.log('Source transaction found:', JSON.stringify(tx))

  // Also catch the feed by matched_payment_id in case the source row (and its
  // moved_to_feed_id pointer) was already removed by an earlier partial run.
  const { data: feedByInvoice } = inv && inv.length > 0
    ? await supabaseAdmin.from('td_bank_feeds').select('id').eq('matched_payment_id', inv[0].id)
    : { data: null }
  const feedIds = new Set<string>()
  if (tx) for (const t of tx) if (t.moved_to_feed_id) feedIds.add(t.moved_to_feed_id)
  if (feedByInvoice) for (const f of feedByInvoice) feedIds.add(f.id)
  if (feedIds.size > 0) {
    const { error: feedErr } = await supabaseAdmin.from('td_bank_feeds').delete().in('id', Array.from(feedIds))
    console.log('Feed(s) deleted:', JSON.stringify({ ids: Array.from(feedIds), error: feedErr }))
  }
  if (tx && tx.length > 0) {
    const { error: txErr } = await supabaseAdmin.from('td_books_transactions').delete().in('id', tx.map(t => t.id))
    console.log('Source transaction deleted:', JSON.stringify({ error: txErr }))
  }
  if (inv && inv.length > 0) {
    const ids = inv.map(i => i.id)
    await supabaseAdmin.from('payment_items').delete().in('payment_id', ids)
    const { error: invErr } = await supabaseAdmin.from('payments').delete().in('id', ids)
    console.log('Invoice deleted:', JSON.stringify({ error: invErr }))
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
