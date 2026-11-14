'use client'

/**
 * The "Signed contracts" card on the Contact page (Overview tab, under the Offers panel).
 * One line per signed offer: the date signed and the installment amounts SAVED in the system, exactly as saved, with a button
 * that opens the signed PDF. The owner can correct a wrong saved amount with Edit.
 * Design: the approved mockup (docs/systems/signed-contracts.md). Data: lib/signed-contracts/load.ts.
 */
import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ExternalLink, FileText, Loader2, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { formatAmount, parseAmountInput } from '@/lib/signed-contracts/amount-input'
import type { SignedContractEntry } from '@/lib/signed-contracts/types'

function dateOf(iso: string | null): string {
  if (!iso) return 'date not recorded'
  try {
    return format(parseISO(iso), 'd MMM yyyy')
  } catch {
    return iso
  }
}

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback)

function AmountsLine({ entry }: { entry: SignedContractEntry }) {
  const a = entry.amounts
  if (!a) return <b className="font-semibold">no installment amounts for this contract</b>
  if (a.kind === 'lines') return <b className="font-semibold">{a.lines.join(' · ')}</b>
  return (
    <b className="font-semibold">
      January {a.january} · June {a.june}
      {a.yearly != null ? ` · yearly ${a.yearly}` : ''}
    </b>
  )
}

function EditForm({
  entry,
  onCancel,
  onSaved,
}: {
  entry: SignedContractEntry
  onCancel: () => void
  /** `next` is null when the amounts were saved but the line could not be read back (the warning then says so) */
  onSaved: (next: SignedContractEntry | null, warning?: string) => void
}) {
  const [january, setJanuary] = useState(entry.editStart?.january ?? '')
  const [june, setJune] = useState(entry.editStart?.june ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const jan = parseAmountInput(january)
  const jun = parseAmountInput(june)
  const bothOk = jan.kind === 'ok' && jun.kind === 'ok'
  const start = {
    january: parseAmountInput(entry.editStart?.january ?? ''),
    june: parseAmountInput(entry.editStart?.june ?? ''),
  }
  const unchanged =
    bothOk &&
    start.january.kind === 'ok' &&
    start.june.kind === 'ok' &&
    jan.value === start.january.value &&
    jun.value === start.june.value
  const firstProblem = jan.kind === 'refused' ? `January: ${jan.error}` : jun.kind === 'refused' ? `June: ${jun.error}` : null
  const yearly = bothOk ? Math.round((jan.value + jun.value) * 100) / 100 : null

  async function save() {
    if (!bothOk) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/crm/signed-contracts/${entry.id}/amounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ january, june, expectedUpdatedAt: entry.updatedAt }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'The amounts could not be saved. Please try again.')
      onSaved((data.entry as SignedContractEntry | null | undefined) ?? null, data.warning)
    } catch (err) {
      setSaveError(errorText(err, 'The amounts could not be saved. Please try again.'))
    } finally {
      setSaving(false)
    }
  }

  const box = 'flex items-center gap-1 rounded-md border-2 border-blue-600 bg-white px-2 py-1.5 text-sm text-zinc-900'
  return (
    <div className="rounded-md bg-zinc-100 px-3 py-3 space-y-2">
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-xs text-zinc-600" htmlFor={`sc-jan-${entry.id}`}>
          January
          <span className={box}>
            {entry.symbol}
            <input
              id={`sc-jan-${entry.id}`}
              inputMode="decimal"
              autoComplete="off"
              value={january}
              onChange={(e) => setJanuary(e.target.value)}
              className="w-28 bg-transparent outline-none"
            />
          </span>
        </label>
        <label className="grid gap-1 text-xs text-zinc-600" htmlFor={`sc-jun-${entry.id}`}>
          June
          <span className={box}>
            {entry.symbol}
            <input
              id={`sc-jun-${entry.id}`}
              inputMode="decimal"
              autoComplete="off"
              value={june}
              onChange={(e) => setJune(e.target.value)}
              className="w-28 bg-transparent outline-none"
            />
          </span>
        </label>
        {entry.source === 'contract' && (
          <div className="grid gap-1 text-xs text-zinc-600">
            Yearly, adds up by itself
            <b className="py-1.5 text-sm font-semibold text-zinc-900">{yearly != null ? formatAmount(yearly, entry.symbol) : '—'}</b>
          </div>
        )}
      </div>
      {bothOk ? (
        <p className="text-xs text-emerald-700">
          Read as: January {formatAmount(jan.value, entry.symbol)} · June {formatAmount(jun.value, entry.symbol)}
        </p>
      ) : (
        <p className="text-xs text-red-700">{firstProblem}</p>
      )}
      {entry.source === 'agreement' && (
        <p className="text-xs text-amber-700">This also changes the amounts the client sees on the renewal agreement page.</p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!bothOk || unchanged || saving}
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Cancel
        </button>
        {unchanged && <span className="text-xs text-zinc-500">Nothing changed yet</span>}
      </div>
      {saveError && <p className="text-xs font-medium text-red-700">{saveError}</p>}
    </div>
  )
}

export function SignedContractsCard({
  entries,
  onEntryCorrected,
  loadError,
  canEditAmounts,
}: {
  /** the lines are held by the page, so a correction is still there after another tab is opened and this card is rebuilt */
  entries: SignedContractEntry[]
  onEntryCorrected: (next: SignedContractEntry) => void
  loadError?: string | null
  canEditAmounts: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  /** lines whose amounts were saved but could not be read back: no second Edit until the page is reloaded */
  const [needsReload, setNeedsReload] = useState<Record<string, true>>({})
  const [opening, setOpening] = useState<string | null>(null)
  const [openProblem, setOpenProblem] = useState<Record<string, string>>({})
  /** a private link that is ready but whose new tab the browser blocked: shown as a link to click (it works for a minute) */
  const [blockedLink, setBlockedLink] = useState<Record<string, string>>({})

  async function openFile(entry: SignedContractEntry) {
    // the tab is opened first, in the click, so a pop-up blocker cannot stop it; it is pointed at the file once the private link is ready
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    setOpening(entry.id)
    setBlockedLink((p) => {
      const { [entry.id]: _old, ...rest } = p
      return rest
    })
    try {
      const res = await fetch(`/api/crm/signed-contracts/${entry.id}/open`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.url) throw new Error(data.error || 'The signed file could not be opened right now.')
      setOpenProblem((p) => {
        const { [entry.id]: _gone, ...rest } = p
        return rest
      })
      if (tab) {
        tab.location.href = data.url
      } else {
        const second = window.open(data.url, '_blank', 'noopener')
        if (!second) setBlockedLink((p) => ({ ...p, [entry.id]: data.url }))
      }
    } catch (err) {
      tab?.close()
      const msg = errorText(err, 'The signed file could not be opened right now.')
      setOpenProblem((p) => ({ ...p, [entry.id]: msg }))
      toast.error(msg)
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="space-y-2" data-testid="signed-contracts-card">
      <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Signed contracts
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium normal-case tracking-normal text-zinc-600">{entries.length}</span>
        <span className="text-xs font-normal normal-case tracking-normal text-zinc-400">what the client signed after reading the offer, newest first</span>
      </h3>

      {loadError && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">The signed contracts could not be loaded: {loadError}</p>
      )}

      {!loadError && entries.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-300 p-5 text-center text-sm text-zinc-500">
          No signed contract yet. A line appears here as soon as the client signs.
        </div>
      )}

      {entries.map((entry) => {
        const problem = !entry.fileAvailable ? 'File can’t be opened right now' : openProblem[entry.id] ? 'File can’t be opened right now' : null
        const isEditing = editing === entry.id
        return (
          <div key={entry.id} className="space-y-2 rounded-lg border border-zinc-200 p-3" data-testid={`signed-contract-${entry.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{entry.chip}</span>
                <b className="text-sm font-semibold">{entry.title}</b>
                {problem && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700" title={openProblem[entry.id]}>{problem}</span>}
              </div>
              <button
                type="button"
                onClick={() => openFile(entry)}
                disabled={!entry.fileAvailable || opening === entry.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-50 px-3.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-400"
              >
                {opening === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                Open signed contract
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>

            {isEditing ? (
              <EditForm
                entry={entry}
                onCancel={() => setEditing(null)}
                onSaved={(next, warning) => {
                  if (next) onEntryCorrected(next)
                  else setNeedsReload((p) => ({ ...p, [entry.id]: true }))
                  setEditing(null)
                  if (warning) toast.warning(warning, { duration: 20000 })
                  else toast.success('Amounts corrected')
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-x-7 gap-y-1 rounded-md bg-zinc-100 px-3 py-2 text-sm">
                <span>
                  <span className="text-zinc-500">Signed</span> <b className="font-semibold">{dateOf(entry.signedAt)}</b>
                </span>
                <span>
                  <span className="text-zinc-500">Saved in the system</span> <AmountsLine entry={entry} />
                </span>
                {needsReload[entry.id] && (
                  <span className="ml-auto text-xs font-medium text-amber-700">Saved. Reload the page to see the new amounts.</span>
                )}
                {canEditAmounts && entry.amountsEditable && !needsReload[entry.id] && (
                  <button
                    type="button"
                    onClick={() => setEditing(entry.id)}
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-blue-200 bg-white px-2.5 py-0.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                )}
              </div>
            )}

            {blockedLink[entry.id] && (
              <p className="text-xs text-zinc-700">
                Your browser blocked the new tab.{' '}
                <a href={blockedLink[entry.id]} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-700 underline">
                  Click here to open the signed contract
                </a>{' '}
                (the link works for one minute).
              </p>
            )}

            {canEditAmounts && !entry.amountsEditable && entry.amounts?.kind === 'lines' && entry.source === 'agreement' && (
              <p className="text-xs text-zinc-500">These amounts are laid out in a way that cannot be edited here.</p>
            )}

            <p className="text-xs text-zinc-600">
              {entry.version ? `Contract v${entry.version} · ` : ''}
              {entry.amounts ? (entry.source === 'agreement' ? 'Amounts saved on the annual agreement · ' : 'Amounts saved on the contract · ') : ''}
              {entry.source === 'contract' && (entry.contractType === 'formation' || entry.contractType === 'onboarding') ? 'Saved together as one file · ' : ''}
              Offer <span className="font-mono text-blue-600">{entry.offerToken}</span>
            </p>
            {entry.correction && (
              <p className="text-xs text-zinc-600">
                Corrected by {entry.correction.byName} on {dateOf(entry.correction.at)}
                {entry.correction.wasText ? ` · was ${entry.correction.wasText}` : ''}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
