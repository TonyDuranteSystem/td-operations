import { supabaseAdmin } from '@/lib/supabase-admin'
import { ReconciliationBoard } from '@/components/payments/reconciliation-board'

export const dynamic = 'force-dynamic'

export default async function ReconciliationPage() {
  // Fetch unmatched + recently matched bank feeds + the review queue
  // (needs_review = candidate awaiting confirmation; activation_crashed = matched
  // invoice but downstream activation failed and needs Retry).
  const [unmatchedRes, matchedRes, openInvoicesRes, needsReviewRes] = await Promise.all([
    supabaseAdmin
      .from('td_bank_feeds')
      .select('*')
      .in('status', ['unmatched'])
      .order('transaction_date', { ascending: false })
      .limit(100),
    supabaseAdmin
      .from('td_bank_feeds')
      .select('*, payments:matched_payment_id(invoice_number, description, account_id, accounts:account_id(company_name))')
      .eq('status', 'matched')
      .order('matched_at', { ascending: false })
      .limit(50),
    supabaseAdmin
      .from('payments')
      .select('id, invoice_number, description, total, amount, amount_currency, invoice_status, account_id, accounts:account_id(company_name)')
      .in('invoice_status', ['Sent', 'Overdue', 'Partial'])
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('td_bank_feeds')
      .select('*, payments:matched_payment_id(invoice_number, description, account_id, accounts:account_id(company_name))')
      .in('status', ['needs_review', 'activation_crashed'])
      .order('transaction_date', { ascending: false })
      .limit(100),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Bank Reconciliation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Match incoming bank transactions to CRM invoices
        </p>
      </div>

      <ReconciliationBoard
        unmatched={unmatchedRes.data ?? []}
        matched={matchedRes.data ?? []}
        openInvoices={openInvoicesRes.data ?? []}
        needsReview={needsReviewRes.data ?? []}
      />
    </div>
  )
}
