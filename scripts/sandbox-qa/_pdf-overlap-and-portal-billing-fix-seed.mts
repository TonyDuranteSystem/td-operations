import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

// QA fixtures for retesting two old, never-shipped fixes brought forward from
// stale PR #476 onto branch claude/pdf-overlap-and-portal-billing-fix:
//  1. wrapPdfParagraphs() — embedded line breaks in an invoice note no longer
//     overlap in the rendered PDF.
//  2. Installment invoices route portal-tier clients to pay via the portal
//     instead of showing wire-transfer instructions (agreement-signed webhook).

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { generateInvoiceNumber } = await import('../../lib/portal/invoice-number')
  const stamp = Date.now()
  const year = 2026

  async function makeAgreementAccount(label: string, portalTier: string | null) {
    const { data: acct, error: acctErr } = await supabaseAdmin
      .from('accounts')
      .insert({
        company_name: `QA-PDFBILL ${label} ${stamp}`,
        account_type: 'Client',
        portal_tier: portalTier,
        installment_1_amount: 1000,
        is_test: true,
      })
      .select('id, company_name, portal_tier')
      .single()
    if (acctErr || !acct) throw new Error(`account insert failed (${label}): ${acctErr?.message}`)

    const token = `qa-pdfbill-${label.toLowerCase().replace(/\s+/g, '-')}-${stamp}`
    const { error: agErr } = await supabaseAdmin
      .from('annual_agreements')
      .insert({
        account_id: acct.id,
        agreement_year: year,
        token,
        status: 'draft',
        client_name: acct.company_name,
      })
    if (agErr) throw new Error(`annual_agreements insert failed (${label}): ${agErr.message}`)

    const { error: conErr } = await supabaseAdmin
      .from('contracts')
      .insert({
        client_name: acct.company_name,
        offer_token: token,
      })
    if (conErr) throw new Error(`contracts insert failed (${label}): ${conErr.message}`)

    console.log(`${label}:`, JSON.stringify({ account_id: acct.id, portal_tier: acct.portal_tier, agreement_token: token }))
    return { accountId: acct.id, token }
  }

  const portalAccount = await makeAgreementAccount('Portal Active', 'active')
  const noPortalAccount = await makeAgreementAccount('No Portal', null)

  // Standalone fixture: a plain Paid-adjacent invoice whose message has real
  // embedded line breaks (bank-transfer-template shape, matching the original
  // INV-002516 report) — a no_portal-tier account so sanitizeInvoiceMessage
  // never touches it and the PDF shows the raw multi-line text verbatim,
  // the clearest possible visual proof of wrapPdfParagraphs.
  const num = await generateInvoiceNumber()
  const messageWithBreaks =
    'Please transfer to:\nBank: Sandbox Test Credit Union\nAccount: 000111222333\nRouting: 999888777\n\nReference the invoice number in the memo line so it can be matched quickly.'
  const { data: inv, error: invErr } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: noPortalAccount.accountId,
      description: `QA-PDFBILL fixture — multi-line note ${stamp}`,
      amount: 500, amount_currency: 'USD', status: 'Pending',
      invoice_number: num, invoice_status: 'Sent',
      issue_date: new Date().toISOString().slice(0, 10),
      subtotal: 500, discount: 0, total: 500,
      amount_due: 500, amount_paid: 0, is_test: true,
      message: messageWithBreaks,
    })
    .select('id, invoice_number').single()
  if (invErr || !inv) throw new Error(`standalone PDF-overlap invoice insert failed: ${invErr?.message}`)
  console.log('Standalone PDF-overlap fixture invoice:', JSON.stringify(inv))

  console.log('\nDONE. Next: POST to /api/webhooks/agreement-signed for both agreement tokens above.')
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
