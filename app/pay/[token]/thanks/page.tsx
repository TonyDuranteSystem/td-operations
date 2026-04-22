/**
 * /pay/<token>/thanks — confirmation page when a client clicks a pay link
 * for an invoice that is already marked Paid (e.g., they clicked the email
 * after paying on the previous tab, or received a receipt email and
 * clicked the archived pay link).
 *
 * Public (middleware PUBLIC_PREFIXES includes '/pay'). No data lookup:
 * the thanks page is intentionally stateless so it can't leak whether a
 * token is valid. Always the same message, regardless of token.
 */
export default function PaymentAlreadyCompletedPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-50 px-4 py-12">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border p-8 text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-emerald-600"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-zinc-900 mb-2">
          This invoice is already paid
        </h1>
        <p className="text-sm text-zinc-600 mb-6">
          Thanks — we&apos;ve received your payment. If you expected to pay,
          check your records or reach out and we&apos;ll sort it out.
        </p>
        <p className="text-xs text-zinc-400">
          Tony Durante LLC · support@tonydurante.us
        </p>
      </div>
    </main>
  )
}
