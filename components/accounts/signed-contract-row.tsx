'use client'

/**
 * "Signed contract" — the line in Company Info, right under "How they became our client" (dev job 49676dfe).
 *
 * One short line per signed contract of THIS company with an Open button; Open shows the signed PDF in the floating document window
 * (movable, resizable, the page behind stays usable) — Antonio 2026-11-14: "in account put a link to the contract to open in a floating
 * page". The private 60-second link comes from the same route the Contact card uses. A company with no contract on record says so;
 * a failed lookup says it could not read the contracts (never "No signed contract"). Editing the amounts stays on the Contact page.
 */
import { useState } from 'react'
import { FileSignature, Loader2 } from 'lucide-react'
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

interface Props {
  /** null = the contracts could not be read just now */
  lines: AccountContractLine[] | null
}

export function SignedContractRow({ lines }: Props) {
  const [opening, setOpening] = useState<string | null>(null) // the contract being fetched
  const [shown, setShown] = useState<{ url: string; fileName: string } | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)

  async function open(line: AccountContractLine) {
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
      <div className="flex items-start gap-2" data-testid="signed-contract-row">
        <FileSignature className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
        <span className="text-muted-foreground min-w-[100px] max-w-[132px] text-sm mt-1">Signed contract</span>
        <div className="flex flex-1 flex-col items-start gap-1.5">
          {lines === null ? (
            <p className="text-sm text-muted-foreground mt-1">The signed contracts could not be read just now. Reload the page to try again.</p>
          ) : lines.length === 0 ? (
            <p className="text-sm text-muted-foreground mt-1">No signed contract in the system</p>
          ) : (
            lines.map((line) => (
              <div key={line.id} className="flex flex-col items-start gap-0.5" data-testid="signed-contract-line">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{line.name}</span>
                  {line.signedOn && <span className="text-xs text-muted-foreground">signed {prettyDate(line.signedOn)}</span>}
                  <button
                    type="button"
                    disabled={!line.fileAvailable || opening !== null}
                    onClick={() => open(line)}
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
      </div>
      {shown && <FloatingDocumentWindow url={shown.url} fileName={shown.fileName} mimeType="application/pdf" onClose={() => setShown(null)} />}
    </>
  )
}
