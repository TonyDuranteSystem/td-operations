'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { changeInvoiceBillTo } from './actions'

/**
 * Finance → "Bill to" (dev job e62bc2b6, Antonio 2026-11-21): change who an invoice is
 * billed to when the client asks. The choices are the offer builder's "Invoice to"
 * choices. The email still goes to the invoice's own contact — only the Bill To changes.
 */

interface Options {
  invoiceNumber: string | null
  status: string | null
  editable: boolean
  current: { label: string; kind: 'person' | 'company' | 'payer'; accountId: string | null; billingEntityId: string | null }
  clientNamedPayer: boolean
  personName: string | null
  hasPerson: boolean
  canAttachPayer: boolean
  companyMoveBlockedReason: string | null
  companies: Array<{ id: string; name: string }>
  entities: Array<{ id: string; name: string }>
  matches: Array<{ id: string; name: string }>
}

const KIND_WORD = { person: 'the person', company: 'a company in the CRM', payer: 'a payer' } as const

export function BillToDialog({ invoiceId, invoiceNumber, onClose }: { invoiceId: string; invoiceNumber: string; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [opts, setOpts] = useState<Options | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // person | company:<id> | entity:<id> | search | new
  const [choice, setChoice] = useState<string>('')
  const [query, setQuery] = useState('')
  const [pickedMatch, setPickedMatch] = useState<string>('')
  const [payer, setPayer] = useState({ name: '', address: '', country: '', vat_number: '' })

  useEffect(() => {
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ payment_id: invoiceId })
      if (choice === 'search' && query.trim().length >= 2) qs.set('q', query.trim())
      fetch(`/api/finance/bill-to-options?${qs.toString()}`, { signal: ctrl.signal })
        .then(async r => {
          if (!r.ok) {
            const d = await r.json().catch(() => ({}))
            throw new Error(d.error || 'Could not load the choices — please try again.')
          }
          return r.json() as Promise<Options>
        })
        .then(setOpts)
        .catch(e => { if (e?.name !== 'AbortError') setLoadError(e instanceof Error && e.message ? e.message : 'Could not load the choices.') })
    }, query ? 250 : 0)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [invoiceId, choice, query])

  const moveBlocked = opts?.companyMoveBlockedReason ?? null

  const payload = (): Record<string, unknown> | null => {
    if (choice === 'person') return { type: 'person' }
    if (choice.startsWith('company:')) return { type: 'company', account_id: choice.slice(8) }
    if (choice.startsWith('entity:')) return { type: 'entity', billing_entity_id: choice.slice(7) }
    if (choice === 'search') return pickedMatch ? { type: 'company', account_id: pickedMatch } : null
    if (choice === 'new') {
      return {
        type: 'entity',
        entity: { name: payer.name.trim(), address: payer.address.trim() || null, country: payer.country.trim() || null, vat_number: payer.vat_number.trim() || null },
      }
    }
    return null
  }

  const movesToCompany = choice.startsWith('company:') || choice === 'search' || choice === 'person'
  const targetCompanyName = choice === 'search'
    ? opts?.matches.find(m => m.id === pickedMatch)?.name
    : opts?.companies.find(c => `company:${c.id}` === choice)?.name

  const save = () => {
    const body = payload()
    if (!body) { toast.error(choice === 'search' ? 'Pick the company from the list.' : 'Choose who the invoice is billed to.'); return }
    if (choice === 'new' && !payer.name.trim()) { toast.error('Enter the payer name.'); return }
    startTransition(async () => {
      const r = await changeInvoiceBillTo(invoiceId, body)
      if (!r.success) { toast.error(r.error ?? 'Could not change the Bill To.'); return }
      if (r.data && !r.data.changed) toast.info('Nothing changed — the invoice is already billed to this.')
      else toast.success(`${invoiceNumber}: Bill to changed from "${r.data?.from}" to "${r.data?.to}"`)
      router.refresh()
      onClose()
    })
  }

  // Drawn straight into <body>: inside a table cell the sticky header row of the invoice list painted over the Save button.
  const dialog = (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4" onClick={e => e.stopPropagation()} role="dialog" aria-label={`Bill to — ${invoiceNumber}`}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Bill to — {invoiceNumber}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        {!opts && !loadError && <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>}
        {loadError && <p className="text-sm text-red-600">{loadError}</p>}

        {opts && (
          <>
            <div className="rounded-md bg-zinc-50 border px-3 py-2 text-sm">
              <div className="text-zinc-500 text-xs">Billed to now</div>
              <div className="font-medium" data-testid="bill-to-current">{opts.current.label} <span className="font-normal text-zinc-500">({KIND_WORD[opts.current.kind]})</span></div>
              {opts.clientNamedPayer && (
                <div className="mt-1 inline-block rounded bg-amber-100 text-amber-800 text-xs px-2 py-0.5">Named by the client on the payment page</div>
              )}
            </div>
            <p className="text-xs text-zinc-500">The invoice email still goes to the client&apos;s own contact. Only the name printed in Bill To changes.</p>

            {!opts.editable ? (
              <p className="text-sm text-red-600">Bill to can only be changed on Draft, Sent, Overdue, Partial or Paid invoices (this one is {opts.status ?? 'a legacy record'}).</p>
            ) : (
              <div className="space-y-2">
                <label className="block text-sm font-medium">Bill to</label>
                <select
                  value={choice}
                  onChange={e => setChoice(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Bill to choice"
                >
                  <option value="">Choose…</option>
                  {opts.hasPerson && (
                    <option value="person" disabled={opts.current.kind === 'person' || Boolean(opts.current.accountId && moveBlocked)}>
                      {opts.personName || 'The person'} (person only, no company)
                    </option>
                  )}
                  {opts.companies.map(c => (
                    <option key={c.id} value={`company:${c.id}`} disabled={c.id !== opts.current.accountId && Boolean(moveBlocked)}>{c.name} (company)</option>
                  ))}
                  {opts.entities.map(b => (
                    <option key={b.id} value={`entity:${b.id}`} disabled={!opts.canAttachPayer}>{b.name} (saved payer)</option>
                  ))}
                  <option value="search" disabled={Boolean(moveBlocked)}>Another company already in the CRM — search…</option>
                  <option value="new" disabled={!opts.canAttachPayer}>Another payer (company or person) — type its details…</option>
                </select>

                {moveBlocked && <p className="text-xs text-amber-700">{moveBlocked}</p>}

                {choice === 'search' && (
                  <div className="space-y-2">
                    <input
                      value={query}
                      onChange={e => { setQuery(e.target.value); setPickedMatch('') }}
                      placeholder="Type the company name…"
                      className="w-full px-3 py-2 text-sm border rounded-md"
                      aria-label="Search companies"
                    />
                    {query.trim().length >= 2 && (
                      <div className="border rounded-md divide-y max-h-44 overflow-y-auto" role="listbox" aria-label="Companies found">
                        {opts.matches.length === 0 && <div className="px-3 py-2 text-sm text-zinc-500">No company found.</div>}
                        {opts.matches.map(m => (
                          <button
                            key={m.id}
                            type="button"
                            role="option"
                            aria-selected={pickedMatch === m.id}
                            onClick={() => setPickedMatch(m.id)}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${pickedMatch === m.id ? 'bg-blue-100 font-medium' : ''}`}
                          >
                            {m.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {choice === 'new' && (
                  <div className="grid grid-cols-2 gap-2">
                    <input value={payer.name} onChange={e => setPayer(p => ({ ...p, name: e.target.value }))} placeholder="Name *" className="px-3 py-2 text-sm border rounded-md col-span-2" aria-label="Payer name" />
                    <input value={payer.address} onChange={e => setPayer(p => ({ ...p, address: e.target.value }))} placeholder="Address" className="px-3 py-2 text-sm border rounded-md col-span-2" aria-label="Payer address" />
                    <input value={payer.country} onChange={e => setPayer(p => ({ ...p, country: e.target.value }))} placeholder="Country" className="px-3 py-2 text-sm border rounded-md" aria-label="Payer country" />
                    <input value={payer.vat_number} onChange={e => setPayer(p => ({ ...p, vat_number: e.target.value }))} placeholder="VAT / tax code" className="px-3 py-2 text-sm border rounded-md" aria-label="Payer VAT" />
                  </div>
                )}

                {movesToCompany && choice !== '' && (
                  <p className="text-xs text-amber-700" data-testid="bill-to-move-warning">
                    {choice === 'person'
                      ? 'The invoice leaves the company and sits on the person only.'
                      : `The invoice moves into ${targetCompanyName ?? 'that company'}'s records (its portal and books). Use this only when that company really is the one billed.`}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-2 text-sm rounded-md border hover:bg-zinc-50">Cancel</button>
          <button
            onClick={save}
            disabled={isPending || !opts?.editable || !choice}
            className="px-3 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? 'Saving…' : 'Save Bill to'}
          </button>
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
