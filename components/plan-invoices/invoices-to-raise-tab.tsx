/**
 * Calendar → "Invoices to raise": the later parts of an offer's payment plan that need a PERSON to raise an invoice (dev job ae3c19db).
 * Antonio, 2026-11-11: "nothing automatic — when it is time, there is an invoice to raise, blinking red; I click it and raise the invoice".
 * SERVER component; the button is a client piece (raise-button.tsx). null = the list could not be read (never shown as "nothing to raise").
 *
 * DUE (red, blinking, on top): a part whose date has come, whose step the offer's job has reached, or whose invoice is a draft nobody sent.
 * COMING UP (grey, underneath): everything else — a future date, a step not reached yet, or "when I say so" (raise it any time).
 * The invoice goes to the offer's own "Invoice to" (the person who signed), named on every row.
 */

import Link from 'next/link'
import { RaiseButton } from '@/components/plan-invoices/raise-button'
import type { InvoiceToRaiseRow } from '@/lib/plan-invoices/types'

function money(amount: number, currency: string): string {
  return `${currency === 'EUR' ? '€' : '$'}${amount.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`
}

function Row({ r }: { r: InvoiceToRaiseRow }) {
  const amountText = money(r.amount, r.currency)
  const draft = r.reason?.kind === 'draft'
  return (
    <li key={r.key} data-testid={r.due ? 'invoice-due' : 'invoice-coming'} className={`rounded-lg border p-4 ${r.due ? 'border-red-300 bg-red-50' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold">{r.clientName}</p>
          <p className="text-sm text-zinc-600">{r.serviceLabel} · {r.partText}</p>
          <p className={`mt-1 text-sm ${r.due ? 'font-medium text-red-800' : r.stepNotFound ? 'text-amber-800' : 'text-zinc-600'}`}>{r.text}</p>
          <p className="mt-1 text-sm text-zinc-700">
            Bill to:{' '}
            {r.payerHref ? <Link href={r.payerHref} prefetch={false} className="underline">{r.payerName ?? 'the client'}</Link> : <b>{r.payerName ?? 'unknown — check the offer'}</b>}
            {r.payerEmail ? <span className="text-zinc-500"> · {r.payerEmail}</span> : null}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <p className="text-xl font-semibold">{amountText}</p>
          <RaiseButton offerToken={r.offerToken} seq={r.seq} summary={`${r.partText} — ${amountText}`} payerName={r.payerName} payerEmail={r.payerEmail} due={r.due} draft={draft} />
        </div>
      </div>
    </li>
  )
}

export function InvoicesToRaiseTab({ rows }: { rows: InvoiceToRaiseRow[] | null }) {
  if (!rows) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
        <p className="font-medium">Could not load the invoices to raise.</p>
        <p className="mt-1">Nothing was changed. This is not &quot;nothing to raise&quot;: reload, or look at the client&apos;s payment schedule on their page.</p>
      </div>
    )
  }
  const due = rows.filter(r => r.due)
  const coming = rows.filter(r => !r.due)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        Later parts of an offer paid in parts. <b>Nothing is raised or emailed by itself</b>: when a part is due (its date, or the step you chose) it turns red here, and
        <b> Raise and send</b> makes the invoice and emails it to whoever signed the contract.
      </div>

      <section aria-label="Due now">
        <h2 className="mb-2 text-sm font-semibold text-red-700">To raise now <span className="font-mono">{due.length}</span></h2>
        {due.length === 0 ? (
          <p className="rounded-lg border px-4 py-6 text-center text-sm text-zinc-600">No invoice is waiting to be raised.</p>
        ) : (
          <ul className="space-y-3">{due.map(r => <Row key={r.key} r={r} />)}</ul>
        )}
      </section>

      <section aria-label="Coming up">
        <h2 className="mb-2 text-sm font-semibold text-zinc-700">Coming up <span className="font-mono">{coming.length}</span></h2>
        {coming.length === 0 ? (
          <p className="rounded-lg border px-4 py-4 text-center text-sm text-zinc-600">Nothing else is scheduled.</p>
        ) : (
          <ul className="space-y-3">{coming.map(r => <Row key={r.key} r={r} />)}</ul>
        )}
      </section>
    </div>
  )
}
