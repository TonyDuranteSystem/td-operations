'use client'

/**
 * Per-row "Issue credit" action on the Referrals page. Shown on a CONVERTED
 * referral that has no credit note yet. One click issues it; if the referrer
 * owns several companies or the amount is blank, it prompts inline (never a
 * dead end); if a credited sibling exists it asks before double-issuing.
 *
 * Resolved values ACCUMULATE: a referral that needs BOTH an amount and a company
 * (no amount + multi-company referrer) collects the amount, then the company,
 * carrying both on every follow-up request — so the second prompt doesn't wipe
 * the first (caught in QA 2026-07-08).
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, BadgeDollarSign } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'

type Candidate = { id: string; name: string | null }
type Prompt =
  | { kind: 'account'; candidates: Candidate[] }
  | { kind: 'amount' }
  | { kind: 'duplicate'; duplicateOf: string }

export function IssueCreditAction({ referralId, referredName, defaultAmount }: {
  referralId: string
  referredName: string
  defaultAmount: number | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [amountInput, setAmountInput] = useState(defaultAmount && defaultAmount > 0 ? String(defaultAmount) : '')
  // Accumulated resolutions carried across chained prompts.
  const [resolved, setResolved] = useState<{ accountId?: string; amountUsd?: number; confirmDuplicate?: boolean }>({})

  async function post(next: { accountId?: string; amountUsd?: number; confirmDuplicate?: boolean }) {
    const body = { ...resolved, ...next }
    setResolved(body)
    setBusy(true)
    try {
      const res = await fetch(`/api/referral/${referralId}/issue-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not issue the credit.')

      if (data.needs === 'account') { setPrompt({ kind: 'account', candidates: data.candidates ?? [] }); return }
      if (data.needs === 'amount') { setPrompt({ kind: 'amount' }); return }
      if (data.needs === 'confirmDuplicate') { setPrompt({ kind: 'duplicate', duplicateOf: data.duplicateOf }); return }

      if (data.alreadyCredited) toast.info('This referral is already credited.')
      else toast.success(`Credit issued${data.invoiceNumber ? ` — ${data.invoiceNumber}` : ''} ($${data.amount}).`)
      setPrompt(null)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not issue the credit.')
    } finally {
      setBusy(false)
    }
  }

  function cancel() { setPrompt(null); setResolved({}) }

  // Inline prompts ----------------------------------------------------------
  if (prompt?.kind === 'account') {
    return (
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <select
          defaultValue=""
          disabled={busy}
          onChange={(e) => e.target.value && post({ accountId: e.target.value })}
          className="rounded border px-1.5 py-1 text-xs"
        >
          <option value="" disabled>Which company?…</option>
          {prompt.candidates.map((c) => <option key={c.id} value={c.id}>{c.name || 'Unnamed company'}</option>)}
        </select>
        <button onClick={cancel} className="text-xs text-zinc-400 hover:text-zinc-600">✕</button>
      </div>
    )
  }
  if (prompt?.kind === 'amount') {
    return (
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-zinc-500">$</span>
        <input
          type="number" step="0.01" min="0" value={amountInput} autoFocus
          onChange={(e) => setAmountInput(e.target.value)}
          className="w-20 rounded border px-1.5 py-1 text-xs"
          placeholder="amount"
        />
        <button
          disabled={busy || !(parseFloat(amountInput) > 0)}
          onClick={() => post({ amountUsd: parseFloat(amountInput) })}
          className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >Issue</button>
        <button onClick={cancel} className="text-xs text-zinc-400 hover:text-zinc-600">✕</button>
      </div>
    )
  }
  if (prompt?.kind === 'duplicate') {
    return (
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-amber-700">Already credited elsewhere.</span>
        <button
          disabled={busy}
          onClick={() => post({ confirmDuplicate: true })}
          className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >Issue anyway</button>
        <button onClick={cancel} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
      </div>
    )
  }

  // Default button ----------------------------------------------------------
  return (
    <FastTooltip label={`Issue the referral credit note for ${referredName}`}>
      <button
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); post({}) }}
        aria-label={`Issue the referral credit note for ${referredName}`}
        className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <BadgeDollarSign className="h-3 w-3" />}
        Issue credit
      </button>
    </FastTooltip>
  )
}
