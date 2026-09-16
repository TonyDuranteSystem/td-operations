import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

// The real agreement-signed webhook (app/api/webhooks/agreement-signed/route.ts)
// sits under /api/webhooks/*, which SANDBOX_MODE middleware blocks with a 503
// unconditionally (CLAUDE.md: "SANDBOX_MODE=1 middleware blocks all
// /api/webhooks/* with 503") — this is a deliberate safety wall, not a bug,
// and not something to route around. This script instead exercises the exact
// SAME real, imported logic and the same real invoice-creation function the
// webhook route calls, against the two fixture accounts already seeded
// (portal_tier='active' and portal_tier=null), to verify the tier-selection
// fix end to end at the data layer.

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { createTDInvoice } = await import('../../lib/portal/td-invoice')
  const { PORTAL_INSTALLMENT_PAYMENT_INSTRUCTION } = await import('../../lib/billing/installment-message')
  const { PORTAL_AUDIENCE_TIERS } = await import('../../lib/portal/pay-token')

  const accounts = [
    { label: 'Portal Active', id: '1e0ccd9c-b70c-42d6-82b3-ae6cfb0f87ec' },
    { label: 'No Portal', id: '423f0dd7-8639-4873-88ba-1653a4cf086b' },
  ]

  for (const { label, id } of accounts) {
    const { data: account, error: acctErr } = await supabaseAdmin
      .from('accounts')
      .select('id, company_name, portal_tier, installment_1_amount')
      .eq('id', id)
      .single()
    if (acctErr || !account) throw new Error(`account lookup failed (${label}): ${acctErr?.message}`)

    // EXACT same logic as app/api/webhooks/agreement-signed/route.ts lines ~116-119
    const isPortalAudience = !!(account.portal_tier && PORTAL_AUDIENCE_TIERS.has(account.portal_tier))
    const paymentInstruction = isPortalAudience
      ? PORTAL_INSTALLMENT_PAYMENT_INSTRUCTION
      : 'Please remit payment by wire transfer.'
    const year = 2026
    const message = `First installment ${year} — LLC Annual Management.\n${paymentInstruction}`

    const idempotencyKey = `qa-installment-routing-${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
    const result = await createTDInvoice({
      account_id: account.id,
      contact_id: null,
      line_items: [{ description: `1st Installment ${year} — LLC Annual Management`, unit_price: account.installment_1_amount || 1000, quantity: 1 }],
      currency: 'USD',
      due_date: `${year}-01-31`,
      message,
      idempotency_key: idempotencyKey,
      installment: 'Installment 1 (Jan)',
      payment_category: 'installment_1',
      year,
    })

    console.log(`${label} (portal_tier=${account.portal_tier}): isPortalAudience=${isPortalAudience}`)
    console.log(`  invoice_number=${result.invoiceNumber} payment_id=${result.paymentId}`)
    console.log(`  message=${JSON.stringify(message)}`)
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
