import { ShoppingBag, FileText, Receipt, CheckCircle2, Clock } from 'lucide-react'

export interface ItinOrigin {
  offer: {
    /** Offer token → contract view link. */
    token: string | null
    /** True when the offer bundled multiple pipelines (vs a standalone ITIN). */
    bundled: boolean
    contractType: string | null
    status: string | null
  } | null
  invoice: {
    invoice_number: string | null
    amount: number | null
    currency: string | null
    paid: boolean
    status: string | null
  } | null
}

function money(amount: number | null, currency: string | null): string {
  if (amount == null) return '—'
  const code = currency ?? 'USD'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount)
  } catch {
    return `${amount} ${code}`
  }
}

/**
 * Purchase Origin card — shown above the stepper on the ITIN Workspace. Tells
 * staff where this ITIN came from: the offer/contract it was sold under (bundled
 * vs standalone, with a link to view the contract) and the invoice (number,
 * amount, paid status). When no offer is linked → "Manual / Legacy ITIN".
 */
export function ItinOriginCard({ origin, contractUrl }: { origin: ItinOrigin; contractUrl: string | null }) {
  const { offer, invoice } = origin

  return (
    <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShoppingBag className="h-4 w-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-900">Purchase Origin</h2>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Offer / contract */}
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          {offer ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    offer.bundled ? 'bg-violet-100 text-violet-700' : 'bg-blue-100 text-blue-700'
                  }`}
                >
                  {offer.bundled ? 'Bundled' : 'Standalone'}
                </span>
                {offer.contractType && (
                  <span className="text-xs capitalize text-zinc-500">{offer.contractType}</span>
                )}
              </div>
              {contractUrl ? (
                <a
                  href={contractUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline"
                >
                  <FileText className="h-3.5 w-3.5" /> View contract
                </a>
              ) : (
                <p className="mt-2 text-sm text-zinc-400">No contract link</p>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-zinc-600">
              <FileText className="h-4 w-4 text-zinc-400" />
              Manual / Legacy ITIN
            </div>
          )}
        </div>

        {/* Invoice */}
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          {invoice ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                  <Receipt className="h-3.5 w-3.5 text-zinc-400" />
                  {invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : 'Invoice'}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    invoice.paid ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {invoice.paid ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                  {invoice.paid ? 'Paid' : invoice.status || 'Unpaid'}
                </span>
              </div>
              <div className="text-sm text-zinc-700">{money(invoice.amount, invoice.currency)}</div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Receipt className="h-4 w-4" /> No invoice on file
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
