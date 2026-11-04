'use client'

/**
 * The State Filing ID check on the onboarding review screen (dev job 64d2be64, Antonio 2026-11-04). Loads the Articles of Organization the
 * client uploaded in the wizard — the reader's number and a link to the real document — and shows the shared check card. Confirm waits
 * for the card (see `onGate`), and what staff decided there is what gets saved on the company.
 *
 * An unchecked number is NEVER saved: when the Articles cannot be loaded, Confirm is offered anyway (after "Try again") but it sends
 * "no Filing ID", and the note says to add it on the company page. When the client uploaded no Articles the card still asks staff to
 * confirm the number the client typed (or say there is none) — there is just no document to open.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { FilingIdCheckCard } from '@/components/flows/filing-id-check-card'
import { FILING_ID_UNRESOLVED, type FilingIdCheckResult } from '@/lib/flows/filing-id-check'

interface ArticlesCheckData {
  has_articles: boolean
  documents: Array<{ path: string; file_name: string; url: string | null; mime_type: string | null }>
  /** Uploaded Articles files that do not belong to this submission: never opened, only counted. */
  unmatched_articles?: number
  read_number: string | null
  read_from: string | null
  read_note: string | null
}

/** What the Confirm button needs from this check. */
export interface FilingIdGate {
  /** True = Confirm must wait (still loading, or the card has not been resolved). */
  blocked: boolean
  /** What to send as `filing_id`: a number, or null (none on the document / nothing could be checked → nothing is saved). */
  choice?: { value: string | null }
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ArticlesCheckData }

export function OnboardingFilingIdCheck({ entryId, clientTyped, einHint, onGate }: { entryId: string; clientTyped: string | null; einHint?: string | null; onGate: (gate: FilingIdGate) => void }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<FilingIdCheckResult>(FILING_ID_UNRESOLVED)

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    fetch(`/api/onboarding-review/${entryId}/articles-check`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok || !d.success) throw new Error((d as { error?: string }).error || 'The Articles could not be loaded.')
        const data = d as ArticlesCheckData
        // Articles were uploaded but no link to any of them could be made: nothing to open, so nothing can be checked
        if (data.has_articles && !data.documents.some((doc) => !!doc.url)) throw new Error('the link to the uploaded Articles could not be made')
        return data
      })
      .then((data) => { if (!cancelled) setLoad({ status: 'ready', data }) })
      .catch((e) => { if (!cancelled) setLoad({ status: 'error', message: e instanceof Error && e.message ? e.message : 'The Articles could not be loaded.' }) })
    return () => { cancelled = true }
  }, [entryId, attempt])

  useEffect(() => {
    if (load.status === 'loading') onGate({ blocked: true })
    // could not be checked → Confirm is not held hostage, but an unchecked number is not saved
    else if (load.status === 'error') onGate({ blocked: false, choice: { value: null } })
    else onGate(result.resolved ? { blocked: false, choice: { value: result.filingId } } : { blocked: true })
  }, [load.status, result, onGate])

  if (load.status === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500" data-testid="filing-id-check-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the Articles of Organization for the State Filing ID…
      </div>
    )
  }

  if (load.status === 'error') {
    return (
      <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="filing-id-check-error">
        <p>
          The Articles could not be loaded for the State Filing ID check ({load.message}).{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="font-medium underline" data-testid="filing-id-check-retry">Try again</button>
        </p>
        <p>
          If it keeps failing you can still confirm, but <strong>no Filing ID will be saved</strong> — add it on the company page afterwards
          {clientTyped ? ` (the client typed ${clientTyped}; it is not checked)` : ''}.
        </p>
      </div>
    )
  }

  const { data } = load
  const shown = data.has_articles ? (data.documents.find((d) => d.path === data.read_from && d.url) ?? data.documents.find((d) => d.url) ?? null) : null
  return (
    <div className="space-y-1.5">
      <FilingIdCheckCard
        reading={false}
        noReader={!data.has_articles}
        readNumber={data.read_number}
        readerNote={data.read_note}
        clientTyped={clientTyped}
        einHint={einHint}
        document={shown && shown.url ? { url: shown.url, name: shown.file_name, mimeType: shown.mime_type } : null}
        documentNote={data.has_articles ? null : 'The client uploaded no Articles of Organization, so there is no document to open. Confirm the number the client typed, or say there is none.'}
        onResult={setResult}
      />
      {data.documents.length > 1 && (
        <p className="text-xs text-zinc-500">{data.documents.length} files were uploaded as the Articles; the window opens {shown?.file_name ?? 'the first one'}.</p>
      )}
      {!!data.unmatched_articles && data.unmatched_articles > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800" data-testid="filing-id-unmatched-articles">
          {data.unmatched_articles} more uploaded Articles file{data.unmatched_articles === 1 ? '' : 's'} could not be matched to this submission and {data.unmatched_articles === 1 ? 'is' : 'are'} not shown here.
        </p>
      )}
    </div>
  )
}
