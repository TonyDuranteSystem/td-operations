import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const mode = process.argv[2]

  const { data: feed, error } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('id, status, amount, currency, sender_name, memo')
    .ilike('sender_name', '%LUSSIGNOLI%')
    .maybeSingle()
  if (error) throw error
  if (!feed) throw new Error('LUSSIGNOLI feed not found')
  console.log('Found feed:', JSON.stringify(feed))

  if (mode === 'settle') {
    // Simulate "something else already settled it" WITHOUT going through any
    // real matching logic — this is purely to prove the render guard keeps
    // UnmatchedRow mounted for a row whose note-link box is open, regardless
    // of why its status changed underneath it.
    const { error: updErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .update({ status: 'matched' })
      .eq('id', feed.id)
    if (updErr) throw updErr
    console.log('Flipped to matched (simulated).')
  } else if (mode === 'revert') {
    const { error: updErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .update({ status: 'unmatched' })
      .eq('id', feed.id)
    if (updErr) throw updErr
    console.log('Reverted to unmatched.')
  } else {
    console.log('Usage: tsx _finance-sync-guard-render-test.mts settle|revert')
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
