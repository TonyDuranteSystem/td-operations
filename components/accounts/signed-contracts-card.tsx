'use client'

/**
 * "Signed contracts" — the card on the company page, right under Offers (dev job bbd2e644; first built as a line in Company Info, job 49676dfe).
 *
 * Antonio 2026-11-14: "what if there is more than one contract? ... another card for signed contract, we open it, choose the contract to
 * click in the floating page". Closed by default, with a one-line summary in the header; open, it lists every signed contract of THIS
 * company, each with an Open button that shows the signed PDF in the floating document window (movable, resizable, the page behind stays
 * usable). The private 60-second link comes from the same route the Contact card uses. A company with no contract on record says so;
 * a failed lookup says it could not read the contracts (never "No signed contract"). Editing the amounts stays on the Contact page.
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, FileSignature, Loader2 } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { FloatingDocumentWindow } from '@/components/ui/floating-document-window'
import type { AccountContractLine } from '@/lib/signed-contracts/account-lines'

const prettyDate = (d: string | null): string => {
  if (!d) return ''
  try {
    return format(parseISO(d), 'MMM d, yyyy')
  } catch {
    return d
  }
}

/** What the closed header says. One contract: its name and day. Several: just the names. None / unreadable: say so. */
export function contractsHeaderSummary(lines: AccountContractLine[] | null): string {
  if (lines === null) return 'Could not be read just now. Reload the page to try again.'
  if (lines.length === 0) return 'No signed contract in the system'
  if (lines.length === 1) {
    const day = prettyDate(lines[0].signedOn)
    return day ? `${lines[0].name} · signed ${day}` : lines[0].name
  }
  return lines.map((l) => l.name).join(' · ')
}

interface Props {
  /** null = the contracts could not be read just now */
  lines: AccountContractLine[] | null
  /** Only for tests: the page always starts the card closed. */
  startOpen?: boolean
}

export function SignedContractsCard({ lines, startOpen = false }: Props) {
  const [open, setOpen] = useState(startOpen)
  const [opening, setOpening] = useState<string | null>(null) // the contract being fetched
  const [shown, setShown] = useState<{ url: string; fileName: string } | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)

  async function openContract(line: AccountContractLine) {
    setOpening(line.id)
    setError(null)
    try {
      const res = await fetch(`/api/crm/signed-contracts/${line.id}/open`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.url) throw new Error(body?.error || 'The signed contract could not be opened. Please try again.')
      const day = prettyDate(line.signedOn)
      setShown({ url: body.url, fileName: `${line.name}${day ? `, signed ${day}` : ''}.pdf` })
    } catch (err) {
      setError({ id: line.id, message: err instanceof Error && err.message ? err.message : 'The signed contract could not be opened. Please try again.' })
    } finally {
      setOpening(null)
    }
  }

  return (
    <>
      <div className="bg-white rounded-lg border p-5 space-y-4" data-testid="signed-contracts-card">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="signed-contracts-toggle"
          className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-left"
        >
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <FileSignature className="h-4 w-4" />
            Signed contracts{lines && lines.length > 0 ? ` (${lines.length})` : ''}
          </h3>
          {!open && (
            <span className={`text-xs ${lines === null ? 'text-amber-700' : 'text-zinc-500'}`} data-testid="signed-contracts-summary">
              {contractsHeaderSummary(lines)}
            </span>
          )}
        </button>

        {open && (
          <div className="space-y-2" data-testid="signed-contracts-body">
            {lines === null ? (
              <p className="text-sm text-muted-foreground">The signed contracts could not be read just now. Reload the page to try again.</p>
            ) : lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No signed contract in the system</p>
            ) : (
              lines.map((line) => (
                <div key={line.id} className="flex flex-col items-start gap-0.5 rounded-lg border border-zinc-200 px-3 py-2" data-testid="signed-contract-line">
                  <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium">{line.name}</span>
                    {line.signedOn && <span className="text-xs text-muted-foreground">signed {prettyDate(line.signedOn)}</span>}
                    <span className="flex-1" />
                    <button
                      type="button"
                      disabled={!line.fileAvailable || opening !== null}
                      onClick={() => openContract(line)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-950/40 dark:text-blue-300"
                    >
                      {opening === line.id && <Loader2 className="h-3 w-3 animate-spin" />}
                      Open
                    </button>
                  </div>
                  {!line.fileAvailable && <p className="text-xs text-amber-700 dark:text-amber-400">The signed file is not available right now.</p>}
                  {error?.id === line.id && <p className="text-xs font-medium text-red-600">{error.message}</p>}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      {shown && <FloatingDocumentWindow url={shown.url} fileName={shown.fileName} mimeType="application/pdf" onClose={() => setShown(null)} />}
    </>
  )
}
