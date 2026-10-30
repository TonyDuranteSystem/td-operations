'use client'

/**
 * "What is this payment?" — the panel at the top of the Bank Feed's Match popup.
 *
 * The owner presses one button; an AI reads the CRM, the Bank Feed and BOTH mailboxes and says who paid and
 * why (server: app/api/finance/investigate-payment/route.ts). The result is kept on the payment, so reopening
 * the popup — for anyone — shows it without running (or paying for) it again.
 *
 * What this panel does NOT do: link, match, create or send anything. It shows what the AI found, where it found
 * it (and which of those sources the SYSTEM could confirm, as opposed to ones the AI only cited), and offers
 * two shortcuts a person still has to confirm: "create a new person for this payer" and "select the invoice it
 * suggests".
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { StoredInvestigation } from '@/lib/finance/feed-investigation'

const VERDICT_STYLE: Record<string, { label: string; className: string }> = {
  identified: { label: 'Identified', className: 'bg-emerald-100 text-emerald-800' },
  likely: { label: 'Probably', className: 'bg-amber-100 text-amber-800' },
  unclear: { label: 'Not sure', className: 'bg-zinc-100 text-zinc-700' },
}

export function readStoredInvestigation(reviewMetadata: unknown): StoredInvestigation | null {
  if (!reviewMetadata || typeof reviewMetadata !== 'object') return null
  const inv = (reviewMetadata as Record<string, unknown>).investigation
  return inv && typeof inv === 'object' && 'verdict' in (inv as object) ? (inv as StoredInvestigation) : null
}

interface Props {
  feedId: string
  stored: StoredInvestigation | null
  isOwner: boolean
  /** Invoices the page already holds, to name the ones the AI suggests. */
  knownInvoices: ReadonlyArray<{ id: string; invoice_number: string | null }>
  saveStory: boolean
  onSaveStoryChange: (value: boolean) => void
  /** Open the "create a new person" card with this name. */
  onCreateNewPerson: (name: string) => void
  /** Tick these (unpaid) invoices in the list below. */
  onSelectInvoices: (ids: string[]) => void
}

export function PaymentInvestigationPanel({ feedId, stored, isOwner, knownInvoices, saveStory, onSaveStoryChange, onCreateNewPerson, onSelectInvoices }: Props) {
  const router = useRouter()
  const [result, setResult] = useState<StoredInvestigation | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unfinished, setUnfinished] = useState<string | null>(null)

  const current = result ?? stored
  // Only the owner can run it, and only the owner needs to see an empty panel.
  if (!current && !isOwner) return null

  async function run(refresh: boolean) {
    setRunning(true)
    setError(null)
    setUnfinished(null)
    try {
      const res = await fetch('/api/finance/investigate-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feed_id: feedId, refresh }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'The investigation could not be run. Try again in a moment.')
      if (d.unfinished) {
        setUnfinished(typeof d.text === 'string' ? d.text : 'The investigation did not reach a conclusion. Nothing was saved.')
      } else if (d.investigation) {
        setResult(d.investigation as StoredInvestigation)
        router.refresh()
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The investigation could not be run. Try again in a moment.')
    } finally {
      setRunning(false)
    }
  }

  const verdict = current ? (VERDICT_STYLE[current.verdict] ?? VERDICT_STYLE.unclear) : null
  const suggested = (current?.suggested_invoice_ids ?? []).map((id) => knownInvoices.find((i) => i.id === id)).filter((i): i is { id: string; invoice_number: string | null } => !!i)
  const writable = current && (current.verdict === 'identified' || current.verdict === 'likely')

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/40 p-2.5 space-y-2" data-testid="payment-investigation">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-violet-600" />
        <p className="text-xs font-semibold text-violet-900">What is this payment?</p>
        {verdict && <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', verdict.className)}>{verdict.label}</span>}
        {isOwner && (
          <button
            type="button"
            onClick={() => run(!!current)}
            disabled={running}
            className="ml-auto text-[11px] px-2 py-0.5 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {running ? 'Reading…' : current ? 'Run again' : 'Investigate'}
          </button>
        )}
      </div>

      {!current && !running && !error && !unfinished && (
        <p className="text-[11px] text-muted-foreground">
          An AI reads the CRM, earlier payments and both mailboxes and tells you who paid and why. It only reads: it never links, creates or sends anything.
        </p>
      )}
      {running && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading the CRM and both mailboxes… this can take up to a minute.
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {unfinished && <p className="text-xs text-amber-700 whitespace-pre-wrap">{unfinished}</p>}

      {current && (
        <div className="space-y-2">
          {(current.who?.name || current.summary) && (
            <p className="text-xs text-zinc-800">
              {current.who?.name && <span className="font-medium">{current.who.name}. </span>}
              {current.summary}
            </p>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-violet-800">Read the story</summary>
            <p className="mt-1 whitespace-pre-wrap text-zinc-700">{current.story || 'No story was written.'}</p>
          </details>

          {current.sources.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide">Sources</p>
              {current.sources.map((s, i) => (
                <p key={`${s.id ?? s.label}-${i}`} className="text-[11px] text-zinc-700 flex items-baseline gap-1.5">
                  <span className="text-zinc-500 shrink-0">{s.kind}{s.mailbox ? ` · ${s.mailbox}` : ''}</span>
                  <span className="truncate">{s.label}{s.date ? ` — ${s.date}` : ''}</span>
                  <span className={cn('shrink-0 text-[9px] px-1 py-px rounded', s.verified ? 'bg-emerald-100 text-emerald-800' : 'bg-zinc-100 text-zinc-600')}>
                    {s.verified ? 'found by the system' : 'cited by the AI'}
                  </span>
                </p>
              ))}
            </div>
          )}

          <p className="text-[10px] text-zinc-500">
            Mailboxes searched: {current.mailboxes_searched.length ? current.mailboxes_searched.join(', ') : 'none'}.
            {current.mailboxes_failed.length > 0 && <span className="text-red-600"> Could not search: {current.mailboxes_failed.join('; ')}.</span>}
            {' '}Spam and Trash included; an email that is only a picture or HTML may show just a preview.
          </p>
          <p className="text-[10px] text-zinc-500">AI-written, so check the sources. Run {String(current.at).slice(0, 10)}.</p>

          <div className="flex flex-wrap items-center gap-2">
            {current.suggested_next === 'create_invoice' && current.who?.name && (
              <button
                type="button"
                onClick={() => onCreateNewPerson(current.who?.name ?? '')}
                className="text-[11px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700"
              >
                Create a new person and invoice for {current.who.name}
              </button>
            )}
            {suggested.length > 0 && (
              <button
                type="button"
                onClick={() => onSelectInvoices(suggested.map((i) => i.id))}
                className="text-[11px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700"
              >
                Select the suggested invoice{suggested.length > 1 ? 's' : ''}: {suggested.map((i) => i.invoice_number ?? 'no number').join(', ')}
              </button>
            )}
          </div>

          {writable && (
            <label className="flex items-start gap-2 cursor-pointer text-[11px] text-zinc-700">
              <input type="checkbox" className="mt-0.5" checked={saveStory} onChange={(e) => onSaveStoryChange(e.target.checked)} />
              <span>Write this story on the invoice note when I link or create it (internal note, labelled AI-written and unverified).</span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}
