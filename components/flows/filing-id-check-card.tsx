'use client'

/**
 * The State Filing ID check (dev job 64d2be64, Antonio 2026-11-04):
 *   "When we have the Articles of Organization there will be a card that says 'This is the number', with a button 'View the real
 *    document'. The document opens in a floating window. We check what the reader found, check the real number, and correct it or
 *    confirm it."
 * The reader only PREFILLS the number. This card makes a person open the real document first, then confirm the number or correct it —
 * or say that the document carries none. The two places that save a Filing ID (the formation upload window, the onboarding review
 * screen) take the card's result and refuse to go on until it is `resolved`.
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FileSearch, Loader2 } from 'lucide-react'
import { FloatingDocumentWindow } from '@/components/ui/floating-document-window'
import { normalizeFilingId } from '@/lib/articles-parse'
import { confirmLockReason, filingIdCheckResult, sameFilingId, type FilingIdCheckResult, type FilingIdDecision } from '@/lib/flows/filing-id-check'

export interface FilingIdCheckDocument {
  url: string
  name: string
  mimeType: string | null
}

export interface FilingIdCheckCardProps {
  /** True while the reader is still reading the Articles. */
  reading: boolean
  /** The number the reader found on the Articles, or null when it found none. */
  readNumber: string | null
  /** Why the reader gave nothing, when that is known ("ran out of time", "file too large") — shown instead of the generic line. */
  readerNote?: string | null
  /** True when there is no document the reader could look at (nothing was uploaded): no "reader" lines are shown at all. */
  noReader?: boolean
  /** Onboarding only: the number the CLIENT typed in the wizard. A usable one prefills the box; a different or unusable one is flagged. */
  clientTyped?: string | null
  /** The real document to open. Null = nothing to open (the note below says why). */
  document: FilingIdCheckDocument | null
  documentNote?: string | null
  disabled?: boolean
  /** Told every time the outcome changes. Pass a STABLE function (a state setter): it sits in an effect's dependencies. */
  onResult: (result: FilingIdCheckResult) => void
}

export function FilingIdCheckCard({ reading, readNumber, readerNote, noReader, clientTyped, document, documentNote, disabled, onResult }: FilingIdCheckCardProps) {
  const clientText = clientTyped?.trim() ?? ''
  const clientUsable = !!normalizeFilingId(clientText)
  const [typed, setTyped] = useState(clientUsable ? clientText : '')
  const touched = useRef(false)
  // opened = the window was opened; viewed = the document has really SHOWN in it (or was opened in a new tab)
  const [opened, setOpened] = useState(false)
  const [viewed, setViewed] = useState(false)
  const [windowOpen, setWindowOpen] = useState(false)
  const [decision, setDecision] = useState<FilingIdDecision>(null)

  // the reader's number lands in the box once it arrives — unless the person already started typing
  useEffect(() => {
    if (!touched.current && readNumber) setTyped(readNumber)
  }, [readNumber])

  useEffect(() => {
    onResult(filingIdCheckResult({ typed, decision }))
  }, [typed, decision, onResult])

  const lock = confirmLockReason({ typed, viewed, hasDocument: !!document, opened })
  const clientDiffers = !!clientText && (!clientUsable || (!!readNumber && !sameFilingId(clientText, readNumber)))

  function choose(value: string) {
    touched.current = true
    setTyped(value)
    setDecision(null)
  }

  return (
    <div className="rounded-lg border border-zinc-300 bg-zinc-50 p-3" data-testid="filing-id-check">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">State Filing ID — check it on the real document</p>

      {noReader ? null : reading ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the Articles…
        </p>
      ) : readNumber ? (
        <p className="mt-2 text-xs text-zinc-600">The reader found <strong className="font-mono">{readNumber}</strong> on the Articles.</p>
      ) : (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800" data-testid="filing-id-reader-none">
          {readerNote ?? 'The reader could not find a Filing ID on this document. Open it and type the number from the real document.'}
        </p>
      )}

      {clientDiffers && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800" data-testid="filing-id-client-differs">
          {clientUsable ? (
            <>
              The client typed <strong className="font-mono">{clientText}</strong>
              {readNumber ? ', which is different from what the reader found.' : '.'}
              <button type="button" onClick={() => choose(clientText)} disabled={disabled} className="ml-2 font-medium underline">Use the client&apos;s number</button>
            </>
          ) : (
            <>The client typed &ldquo;{clientText}&rdquo;, which is not a Filing ID number.</>
          )}
        </p>
      )}

      <label className="mt-3 block text-sm font-medium text-zinc-800">
        This is the number
        <input
          type="text"
          value={typed}
          maxLength={40}
          onChange={(e) => choose(e.target.value)}
          disabled={disabled || decision === 'none'}
          placeholder="e.g. 2026-002103965"
          data-testid="articles-filing-id"
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-base disabled:bg-zinc-100 disabled:text-zinc-400"
        />
      </label>
      <p className="mt-1 text-xs text-zinc-500">
        Wyoming: &ldquo;Original ID&rdquo; · New Mexico: &ldquo;File #&rdquo; · Florida: the L… document number · Delaware: &ldquo;File Number&rdquo;.
        It is saved on the company.
      </p>

      {document ? (
        <button
          type="button"
          onClick={() => { setWindowOpen(true); setOpened(true) }}
          disabled={disabled}
          data-testid="filing-id-view-document"
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-blue-600 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        >
          <FileSearch className="h-4 w-4" />
          View the real document
        </button>
      ) : (
        documentNote && <p className="mt-3 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-600" data-testid="filing-id-no-document">{documentNote}</p>
      )}

      {decision === 'confirmed' ? (
        <p className="mt-3 flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-sm text-emerald-800" data-testid="filing-id-confirmed">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Checked: <strong className="font-mono">{filingIdCheckResult({ typed, decision }).filingId}</strong> will be saved on the company.</span>
          <button type="button" onClick={() => setDecision(null)} disabled={disabled} className="ml-auto text-xs font-medium underline">Change</button>
        </p>
      ) : decision === 'none' ? (
        <p className="mt-3 flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-sm text-emerald-800" data-testid="filing-id-none">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Checked: this document has no Filing ID, so none will be saved.</span>
          <button type="button" onClick={() => setDecision(null)} disabled={disabled} className="ml-auto text-xs font-medium underline">Change</button>
        </p>
      ) : (
        <div className="mt-3 space-y-1.5">
          <button
            type="button"
            onClick={() => setDecision('confirmed')}
            disabled={disabled || !!lock}
            data-testid="filing-id-confirm"
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
          >
            <CheckCircle2 className="h-4 w-4" />
            The number is correct
          </button>
          {lock && <p className="text-xs text-zinc-500" data-testid="filing-id-lock">{lock}</p>}
          <div>
            <button
              type="button"
              onClick={() => setDecision('none')}
              disabled={disabled || (!!document && !viewed)}
              data-testid="filing-id-none-button"
              className="text-xs font-medium text-zinc-600 underline disabled:cursor-not-allowed disabled:text-zinc-400 disabled:no-underline"
            >
              There is no Filing ID on this document
            </button>
          </div>
        </div>
      )}

      {windowOpen && document && (
        <FloatingDocumentWindow
          url={document.url}
          fileName={document.name}
          mimeType={document.mimeType}
          onShown={() => setViewed(true)}
          onClose={() => setWindowOpen(false)}
        />
      )}
    </div>
  )
}
