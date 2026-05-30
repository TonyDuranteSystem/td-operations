'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, X, Search, Loader2 } from 'lucide-react'

interface Actor {
  kind: 'account' | 'contact'
  id: string
  name: string
  account_type?: string | null
  account_id?: string | null   // for contacts: their linked account
  account_name?: string | null
  setup_fee_total: number
  default_credit_usd: number
}

/** Search any actor (account of any type, incl. Partner, OR contact). */
function ActorPicker({ label, value, onPick, onClear, placeholder }: {
  label: string; value: Actor | null; placeholder: string
  onPick: (a: Actor) => void; onClear: () => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Actor[]>([])
  const [loading, setLoading] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)

  function search(term: string) {
    setQ(term)
    if (t.current) clearTimeout(t.current)
    if (term.trim().length < 2) { setHits([]); return }
    t.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/referral/manual?q=${encodeURIComponent(term)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Search failed.')
        setHits(data.results ?? [])
      } catch (err) { toast.error(err instanceof Error ? err.message : 'Search failed.') }
      finally { setLoading(false) }
    }, 250)
  }

  const badge = (a: Actor) => a.kind === 'account' ? (a.account_type || 'Account') : 'Contact'

  return (
    <div className="relative">
      <label className="mb-1 block text-xs font-medium text-zinc-600">{label}</label>
      {value ? (
        <div className="flex items-center justify-between rounded-md border bg-zinc-50 px-3 py-2 text-sm">
          <span>
            <span className="mr-2 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600">{badge(value)}</span>
            {value.name}
            {value.kind === 'contact' && value.account_name ? <span className="text-zinc-400"> · {value.account_name}</span> : ''}
          </span>
          <button onClick={() => { onClear(); setQ('') }} className="text-zinc-400 hover:text-zinc-600"><X className="h-4 w-4" /></button>
        </div>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
          {loading && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-zinc-400" />}
          <input value={q} onChange={e => search(e.target.value)} placeholder={placeholder}
            className="w-full rounded-md border px-8 py-2 text-sm focus:border-blue-500 focus:outline-none" />
          {hits.length > 0 && (
            <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-white shadow-lg">
              {hits.map(a => (
                <button key={`${a.kind}:${a.id}`} onClick={() => { onPick(a); setHits([]) }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50">
                  <span className="mr-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">{badge(a)}</span>
                  {a.name}
                  {a.kind === 'contact' && a.account_name ? <span className="text-zinc-400"> · {a.account_name}</span> : ''}
                  {a.setup_fee_total > 0 ? <span className="text-zinc-400"> · setup ${a.setup_fee_total}</span> : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** "Add referral" — record a referral (referrer → referred, each a contact OR
 *  account of any type) and issue the referrer's 10% USD credit (editable). */
export function AddReferralModal() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [referrer, setReferrer] = useState<Actor | null>(null)
  const [referred, setReferred] = useState<Actor | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  function reset() { setReferrer(null); setReferred(null); setAmount(''); setNote('') }

  async function submit() {
    if (!referrer) { toast.error('Pick a referrer.'); return }
    if (!referred) { toast.error('Pick the referred client.'); return }
    const amt = parseFloat(amount)
    if (!(amt > 0)) { toast.error('Enter a credit amount greater than 0.'); return }
    setSubmitting(true)
    try {
      const payload = {
        referrerContactId: referrer.kind === 'contact' ? referrer.id : null,
        referrerAccountId: referrer.kind === 'account' ? referrer.id : null,
        referrerType: referrer.kind === 'account' && (referrer.account_type || '').toLowerCase() === 'partner' ? 'partner' : 'client',
        referredContactId: referred.kind === 'contact' ? referred.id : null,
        referredAccountId: referred.kind === 'account' ? referred.id : null,
        referredName: referred.name,
        amountUsd: amt,
        note: note.trim() || null,
      }
      const res = await fetch('/api/referral/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not create the referral.')
      toast.success(`Referral added — $${data.amount} credit issued to ${referrer.name}.`)
      setOpen(false); reset(); router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not create the referral.')
    } finally { setSubmitting(false) }
  }

  return (
    <>
      <button onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors">
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
              <ActorPicker label="Referrer — who gets the credit (contact OR account/partner)" value={referrer} placeholder="Search referrer…"
                onPick={setReferrer} onClear={() => setReferrer(null)} />

              <ActorPicker label="Referred client (contact or account)" value={referred} placeholder="Search referred client…"
                onPick={(a) => { setReferred(a); setAmount(a.default_credit_usd > 0 ? String(a.default_credit_usd) : '') }}
                onClear={() => { setReferred(null); setAmount('') }} />

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Credit amount (USD) — 10% of setup fee, editable</label>
                <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"
                  className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
              </div>

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
