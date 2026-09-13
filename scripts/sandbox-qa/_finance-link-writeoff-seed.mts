import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
const TD_ENTITY_ID = '00000000-0000-0000-0000-000000000001'

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const today = new Date().toISOString().slice(0, 10)

  // TX-A: native My Finances transaction, NOT yet sent to Finance — used to
  // exercise the full two-step round trip (scenario 7) via the real UI.
  const { data: txA, error: txAErr } = await supabaseAdmin
    .from('td_books_transactions')
    .insert({
      entity_id: TD_ENTITY_ID,
      transaction_date: today,
      amount: 300,
      currency: 'USD',
      description: 'QA-LINKWRITEOFF fixture — plain partial payment round trip',
      counterparty: 'QA LINKWRITEOFF SENDER A',
      bank_name: 'QA Test Bank',
      account_type: 'checking',
      category: 'uncategorized',
      tax_year: new Date(today).getFullYear(),
      transaction_ref: `qa-linkwriteoff-a-${Date.now()}`,
    })
    .select('id')
    .single()
  console.log('TX-A (native, not yet sent):', JSON.stringify({ data: txA, error: txAErr }))

  // Feed-B: pre-seeded directly in td_bank_feeds — simulates "already sent to
  // Finance" so scenario 2 (single-line write-off) tests Step 2 only.
  const { data: feedB, error: feedBErr } = await (supabaseAdmin as any)
    .from('td_bank_feeds')
    .insert({
      external_id: `qa-linkwriteoff-b-${Date.now()}`,
      transaction_date: today,
      amount: 400,
      currency: 'USD',
      source: 'manual',
      sender_name: 'QA LINKWRITEOFF SENDER B',
      memo: 'QA-LINKWRITEOFF fixture — single-line write-off',
      status: 'unmatched',
      review_metadata: { client_payment_claim: { by: 'qa-script', at: new Date().toISOString() } },
    })
    .select('id')
    .single()
  console.log('Feed-B (pre-seeded in Finance):', JSON.stringify({ data: feedB, error: feedBErr }))

  // Feed-C: pre-seeded — simulates "already sent to Finance" for scenario 3,
  // the CRITICAL multi-line write-off regression check.
  const { data: feedC, error: feedCErr } = await (supabaseAdmin as any)
    .from('td_bank_feeds')
    .insert({
      external_id: `qa-linkwriteoff-c-${Date.now()}`,
      transaction_date: today,
      amount: 400,
      currency: 'USD',
      source: 'manual',
      sender_name: 'QA LINKWRITEOFF SENDER C',
      memo: 'QA-LINKWRITEOFF fixture — multi-line write-off',
      status: 'unmatched',
      review_metadata: { client_payment_claim: { by: 'qa-script', at: new Date().toISOString() } },
    })
    .select('id')
    .single()
  console.log('Feed-C (pre-seeded in Finance):', JSON.stringify({ data: feedC, error: feedCErr }))

  // Feed-D: a Stripe-sourced row already flagged refunded_or_disputed — to
  // verify the UI-level guard (scenario 6a). No real Stripe key exists in
  // sandbox, so the LIVE server-side re-check (scenario 6b) cannot be
  // exercised here — that logic is covered by mocked unit tests instead.
  const { data: feedD, error: feedDErr } = await (supabaseAdmin as any)
    .from('td_bank_feeds')
    .insert({
      external_id: `qa-linkwriteoff-d-${Date.now()}`,
      transaction_date: today,
      amount: 250,
      currency: 'USD',
      source: 'stripe',
      sender_name: 'QA LINKWRITEOFF SENDER D (refunded)',
      memo: 'QA-LINKWRITEOFF fixture — refunded/disputed guard',
      status: 'unmatched',
      review_metadata: { refunded_or_disputed: true, checked_at: new Date().toISOString() },
    })
    .select('id')
    .single()
  console.log('Feed-D (refunded/disputed flagged):', JSON.stringify({ data: feedD, error: feedDErr }))
}
main()
