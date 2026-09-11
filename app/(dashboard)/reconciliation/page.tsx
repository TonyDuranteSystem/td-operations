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

  // PRIVACY, ENFORCED ON THE SERVER (same doctrine as finance/page.tsx's privacy filter,
  // applied differently here on purpose): this page's own queries already exclude the
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

  // The check above only ever runs on 'unmatched' rows — isClientInvoicePayment (which
  // isOwnerLedgerFeed is built on) treats a 'matched' feed as an unconditional client
  // settlement, on purpose (reversing a completed match automatically is a separate, bigger
  // decision this codebase does not make here). That means a genuinely-owner deposit that got
  // WRONGLY matched to a client's invoice by a content coincidence — the same class of mistake
  // this file's own money-routing rules document happening for real — would pass the check
  // above and stay permanently visible. Rather than reverse the match, hide it from non-owners
  // on the one signal that's certain regardless of match status: Plaid resolving the transaction
  // to one of Antonio's own registered accounts (owner_account_number, set only by
  // lib/plaid-sync.ts). A matched row with no such identity is unaffected.
  let matchedRows = matchedRes.data ?? []
  if (!viewerIsOwner) {
    matchedRows = matchedRows.filter((feed) => !(feed as { owner_account_number?: unknown }).owner_account_number)
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
        matched={matchedRows}
        openInvoices={(openInvoicesRes.data ?? []) as unknown as OpenInvoice[]}
      />
    </div>
  )
}
