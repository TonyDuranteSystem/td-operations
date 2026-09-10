import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import {
  buildOwnerLedgerEvidenceContext,
  isOwnerLedgerFeed,
  type ProjectableFeed,
} from '@/lib/finance/owner-ledger-projection'
import { ReconciliationBoard, type OpenInvoice } from '@/components/payments/reconciliation-board'

export const dynamic = 'force-dynamic'

export default async function ReconciliationPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const viewerIsOwner = isOwnerOnly(user)

  // Fetch unmatched + recently matched bank feeds
  const [unmatchedRes, matchedRes, openInvoicesRes] = await Promise.all([
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
      .select('id, invoice_number, description, total, amount, amount_currency, invoice_status, account_id, accounts:account_id(company_name), contact_id, contacts:payments_contact_id_fkey(full_name)')
      .in('invoice_status', ['Sent', 'Overdue', 'Partial'])
      .order('created_at', { ascending: false }),
  ])

  // PRIVACY, ENFORCED ON THE SERVER (same doctrine as finance/page.tsx's PRIVATE_TO_OWNER
  // filter, applied differently here on purpose): this page's own queries already exclude the
  // 'outgoing'/'owner_ledger' statuses by construction (they only ever select 'unmatched' and
  // 'matched'), so a status-based filter mirrored from Finance would remove nothing — the real
  // exposure is a genuinely-owner transaction sitting at 'unmatched' BEFORE the periodic sweep
  // (check-wire-payments, every 6h) has reclassified it, or indefinitely if the router never
  // does. Non-owners get the SAME classification check the sweep itself uses, run live, so a
  // private row never reaches their screen in the first place rather than being hidden by a
  // status that was never actually present.
  let unmatchedRows = unmatchedRes.data ?? []
  if (!viewerIsOwner && unmatchedRows.length > 0) {
    const { openInvoices: ownerOpenInvoices, evidence } =
      await buildOwnerLedgerEvidenceContext(unmatchedRows as ProjectableFeed[])
    unmatchedRows = unmatchedRows.filter(
      (feed) => !isOwnerLedgerFeed(feed as ProjectableFeed, ownerOpenInvoices, evidence)
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Bank Reconciliation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Match incoming bank transactions to CRM invoices
        </p>
      </div>

      <ReconciliationBoard
        unmatched={unmatchedRows}
        matched={matchedRes.data ?? []}
        openInvoices={(openInvoicesRes.data ?? []) as unknown as OpenInvoice[]}
      />
    </div>
  )
}
