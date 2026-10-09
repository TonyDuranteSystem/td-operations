'use client'

import Link from 'next/link'
import { ArrowRight, X } from 'lucide-react'

/**
 * Big green callout hanging under the "Customers & Invoices" menu item (Antonio 2026-10-09, dev job 1a23f5f1).
 * The sidebar owns the "seen" memory (key td-invoices-hub-new-v1) and decides when to show it; this only draws it.
 */
export function InvoicesMenuCallout({ title, desc, cta, dismissLabel, onClear }: {
  title: string
  desc: string
  cta: string
  dismissLabel: string
  onClear: () => void
}) {
  return (
    <div
      data-testid="invoices-menu-callout"
      className="relative mt-1 mb-2 ml-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 p-3 motion-safe:animate-pulse"
    >
      <span aria-hidden="true" className="absolute -top-[7px] left-6 h-3 w-3 rotate-45 border-l-2 border-t-2 border-emerald-500 bg-emerald-50" />
      <button onClick={onClear} aria-label={dismissLabel} className="absolute right-1.5 top-1.5 p-1 text-emerald-500 hover:text-emerald-700">
        <X className="h-3.5 w-3.5" />
      </button>
      <p className="pr-5 text-sm font-semibold text-emerald-950">{title}</p>
      <p className="mt-1 text-xs text-emerald-800">{desc}</p>
      <Link
        href="/portal/invoices"
        onClick={onClear}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
      >
        {cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  )
}
