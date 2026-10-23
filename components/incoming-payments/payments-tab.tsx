/**
 * Calendar → "Payments to confirm": money that arrived through a Stripe link with no label, which the system therefore did NOT
 * act on (no lead converted, nothing recorded). Staff say what each one was. SERVER component; the buttons are a client piece.
 * null = the list could not be read (never shown as "nothing waiting").
 */

import { ConfirmActions } from '@/components/incoming-payments/confirm-actions'
import type { WaitingRow } from '@/lib/incoming-payments/classify'

function money(amount: number, currency: string): string {
  return `${currency === 'EUR' ? '€' : '$'}${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function PaymentsToConfirmTab({ rows }: { rows: WaitingRow[] | null }) {
  if (!rows) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
        <p className="font-medium">Could not load the payments waiting for confirmation.</p>
        <p className="mt-1">Nothing was changed. This is not &quot;nothing waiting&quot;: reload, or check the Stripe dashboard.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        These payments came in through a Stripe link that says nothing about what it is for (for example a link made by hand in Stripe).
        The system did <b>not</b> touch any lead or client for them. Say what each one was; until then the money is only in Stripe.
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border px-4 py-6 text-center text-sm text-zinc-600">Nothing is waiting for confirmation.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map(r => {
            const amountText = money(r.amount, r.currency)
            return (
              <li key={r.sessionId} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-base font-semibold">{r.name || r.email || 'Unknown payer'}</p>
                    <p className="text-sm text-zinc-600">{r.email ?? 'no email'} · paid {when(r.paidAt)}</p>
                  </div>
                  <p className="text-xl font-semibold">{amountText}</p>
                </div>

                <p className="mt-2 text-sm text-zinc-700">
                  {r.match.leads.length > 0 && <>Lead with this email: {r.match.leads.map(l => `${l.name || 'Unnamed'} (${l.status})`).join(', ')}. </>}
                  {r.match.contacts.length > 0 && <>Client contact with this email: {r.match.contacts.map(c => c.name || 'Unnamed').join(', ')}. </>}
                  {r.match.marketingLeads.length > 0 && (
                    <b className="text-amber-800">This email is also a TD Marketing lead ({r.match.marketingLeads.map(m => m.name || 'Unnamed').join(', ')}): choose <i>Marketing sale</i> (marketing sales follow marketing&apos;s own rules), not a paid call. </b>
                  )}
                  {r.match.leads.length === 0 && r.match.contacts.length === 0 && r.match.marketingLeads.length === 0 && <>No lead, client or marketing lead has this email.</>}
                </p>

                <div className="mt-3">
                  <ConfirmActions sessionId={r.sessionId} amount={r.amount} currency={r.currency} amountText={amountText} leads={r.match.leads} invoices={r.invoices} searchSeed={r.name || r.email || ''} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
