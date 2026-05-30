'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, X, Search, Loader2 } from 'lucide-react'

interface ContactHit { id: string; full_name: string; email: string | null }
interface AccountHit { id: string; company_name: string; setup_fee_total: number; default_credit_usd: number }

/** "Add referral" — manually record a referral (referrer client → referred client)
 *  and issue the referrer's 10% USD credit (editable). Dashboard-only. */
export function AddReferralModal() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // referrer (contact)
  const [refQ, setRefQ] = useState('')
  const [refHits, setRefHits] = useState<ContactHit[]>([])
  const [referrer, setReferrer] = useState<ContactHit | null>(null)

  // referred (account)
  const [cliQ, setCliQ] = useState('')
  const [cliHits, setCliHits] = useState<AccountHit[]>([])
  const [referred, setReferred] = useState<AccountHit | null>(null)

  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tRef2 = useRef<ReturnType<typeof setTimeout> | null>(null)

  function reset() {
    setRefQ(''); setRefHits([]); setReferrer(null)
    setCliQ(''); setCliHits([]); setReferred(null)
    setAmount(''); setNote('')
  }

  async function searchContacts(q: string) {
    setRefQ(q); setReferrer(null)
    if (tRef.current) clearTimeout(tRef.current)
    if (q.trim().length < 2) { setRefHits([]); return }
    tRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Search failed.')
        setRefHits(data.contacts ?? [])
      } catch (err) { toast.error(err instanceof Error ? err.message : 'Contact search failed.') }
    }, 250)
  }

  async function searchAccounts(q: string) {
    setCliQ(q); setReferred(null)
    if (tRef2.current) clearTimeout(tRef2.current)
    if (q.trim().length < 2) { setCliHits([]); return }
    tRef2.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/referral/manual?q=${encodeURIComponent(q)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Search failed.')
        setCliHits(data.accounts ?? [])
      } catch (err) { toast.error(err instanceof Error ? err.message : 'Client search failed.') }
    }, 250)
  }

  function pickReferred(a: AccountHit) {
    setReferred(a); setCliQ(a.company_name); setCliHits([])
    // prefill the 10% default (editable)
    setAmount(a.default_credit_usd > 0 ? String(a.default_credit_usd) : '')
  }

  async function submit() {
    if (!referrer) { toast.error('Pick a referrer.'); return }
    if (!referred) { toast.error('Pick the referred client.'); return }
    const amt = parseFloat(amount)
    if (!(amt > 0)) { toast.error('Enter a credit amount greater than 0.'); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/referral/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          referrerContactId: referrer.id,
          referredAccountId: referred.id,
          referredName: referred.company_name,
          amountUsd: amt,
          note: note.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not create the referral.')
      toast.success(`Referral added — $${data.amount} credit issued to ${referrer.full_name}.`)
      setOpen(false); reset(); router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not create the referral.')
    } finally { setSubmitting(false) }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
      >
        <Plus className="h-4 w-4" /> Add referral
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !submitting && setOpen(false)}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h3 className="text-base font-semibold">Add referral manually</h3>
              <button onClick={() => !submitting && setOpen(false)} className="text-zinc-400 hover:text-zinc-600"><X className="h-5 w-5" /></button>
            </div>

            <div className="space-y-4 px-5 py-4">
              {/* Referrer */}
              <div className="relative">
                <label className="mb-1 block text-xs font-medium text-zinc-600">Referrer (existing client)</label>
                {referrer ? (
                  <div className="flex items-center justify-between rounded-md border bg-zinc-50 px-3 py-2 text-sm">
                    <span>{referrer.full_name}{referrer.email ? ` · ${referrer.email}` : ''}</span>
                    <button onClick={() => { setReferrer(null); setRefQ('') }} className="text-zinc-400 hover:text-zinc-600"><X className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
                    <input value={refQ} onChange={e => searchContacts(e.target.value)} placeholder="Search referrer by name/email…"
                      className="w-full rounded-md border px-8 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                    {refHits.length > 0 && (
                      <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-white shadow-lg">
                        {refHits.map(c => (
                          <button key={c.id} onClick={() => { setReferrer(c); setRefHits([]) }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50">
                            {c.full_name}{c.email ? <span className="text-zinc-400"> · {c.email}</span> : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Referred client */}
              <div className="relative">
                <label className="mb-1 block text-xs font-medium text-zinc-600">Referred client (account)</label>
                {referred ? (
                  <div className="flex items-center justify-between rounded-md border bg-zinc-50 px-3 py-2 text-sm">
                    <span>{referred.company_name}<span className="text-zinc-400"> · setup ${referred.setup_fee_total}</span></span>
                    <button onClick={() => { setReferred(null); setCliQ(''); setAmount('') }} className="text-zinc-400 hover:text-zinc-600"><X className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
                    <input value={cliQ} onChange={e => searchAccounts(e.target.value)} placeholder="Search referred client by company…"
                      className="w-full rounded-md border px-8 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                    {cliHits.length > 0 && (
                      <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-white shadow-lg">
                        {cliHits.map(a => (
                          <button key={a.id} onClick={() => pickReferred(a)}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50">
                            {a.company_name}<span className="text-zinc-400"> · setup ${a.setup_fee_total} → ${a.default_credit_usd} credit</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Amount */}
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Credit amount (USD) — 10% of setup fee, editable</label>
                <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"
                  className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
              </div>

              {/* Note */}
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Note (optional)</label>
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. confirmed by phone"
                  className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <button onClick={() => !submitting && setOpen(false)} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">Cancel</button>
              <button onClick={submit} disabled={submitting || !referrer || !referred}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Add referral + issue credit
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
