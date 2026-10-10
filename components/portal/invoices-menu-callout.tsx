'use client'

import Link from 'next/link'
import { ArrowRight, X } from 'lucide-react'

/**
 * Big green callout hanging under the "Customers & Invoices" menu item (Antonio 2026-10-09, dev job 1a23f5f1).
 * The sidebar owns the "seen" memory (key td-invoices-hub-new-v2:<company id>) and decides when to show it; this only draws it.
 */
export function InvoicesMenuCallout({ title, desc, cta, dismissLabel, onDismiss, onOpen }: {
  title: string
  desc: string
  cta: string
  dismissLabel: string
  onDismiss: () => void
  onOpen: () => void
}) {
  return (
    <div
      data-testid="invoices-menu-callout"
      className="relative mt-1 mb-2 ml-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 p-3"
    >
      {/* Only the glowing outline blinks, so the words stay fully readable. */}
      <span aria-hidden="true" className="pointer-events-none absolute -inset-0.5 rounded-xl ring-4 ring-emerald-400/60 motion-safe:animate-pulse" />
      <span aria-hidden="true" className="absolute -top-[7px] left-6 h-3 w-3 rotate-45 border-l-2 border-t-2 border-emerald-500 bg-emerald-50" />
      <button onClick={onDismiss} aria-label={dismissLabel} className="absolute right-1 top-1 p-1.5 text-emerald-600 hover:text-emerald-800">
        <X className="h-4 w-4" />
      </button>
      <p className="pr-5 text-sm font-semibold text-emerald-950">{title}</p>
      <p className="mt-1 text-xs text-emerald-800">{desc}</p>
      <Link
        href="/portal/invoices"
        onClick={onOpen}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
      >
        {cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  )
}
