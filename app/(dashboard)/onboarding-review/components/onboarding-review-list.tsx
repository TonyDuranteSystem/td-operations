'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, FileText, ExternalLink, Loader2, CheckCircle2 } from 'lucide-react'
import type { OnboardingReviewEntry } from '../page'

interface OnboardingReviewListProps {
  entries: OnboardingReviewEntry[]
}

export function OnboardingReviewList({ entries }: OnboardingReviewListProps) {
  return (
    <div className="bg-white rounded-lg border divide-y">
      {entries.map((entry) => (
        <OnboardingReviewRow key={entry.id} entry={entry} />
      ))}
    </div>
  )
}

function formatDate(d: string | null) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return d
  }
}

function OnboardingReviewRow({ entry }: { entry: OnboardingReviewEntry }) {
  const [expanded, setExpanded] = useState(false)
  const companyName = (entry.submitted_data.company_name as string) || 'Unnamed company'
  const changedCount = entry.changed_fields ? Object.keys(entry.changed_fields).length : 0

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-zinc-50"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
          )}
          <div>
            <div className="font-medium text-sm">
              {entry.lead_name} — {companyName}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {entry.entity_type || '—'} · {entry.state || '—'} · submitted {formatDate(entry.completed_at)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {entry.upload_paths.length > 0 && (
            <span className="inline-flex items-center gap-1 bg-zinc-100 text-zinc-600 px-2 py-1 rounded">
              <FileText className="h-3 w-3" />
              {entry.upload_paths.length}
            </span>
          )}
          {changedCount > 0 && (
            <span className="bg-amber-100 text-amber-700 px-2 py-1 rounded">
              {changedCount} changed
            </span>
          )}
        </div>
      </button>

      {expanded && <OnboardingReviewDetail entry={entry} />}
    </div>
  )
}

interface DocumentRow {
  path: string
  file_name: string
  url: string | null
}

function OnboardingReviewDetail({ entry }: { entry: OnboardingReviewEntry }) {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null)
  const [docsError, setDocsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/onboarding-review/${entry.id}/documents`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (data.success) setDocuments(data.documents)
        else setDocsError(data.error || 'Could not load documents')
      })
      .catch((e) => {
        if (!cancelled) setDocsError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [entry.id])

  const fields = Object.entries(entry.submitted_data).filter(
    ([key]) => key !== 'additional_members',
  )
  const members = (entry.submitted_data.additional_members as Array<Record<string, string>>) || []

  return (
    <div className="px-4 pb-4 pl-11 space-y-4">
      <div>
        <h4 className="text-xs font-semibold text-zinc-500 uppercase mb-2">Submitted information</h4>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm bg-zinc-50 rounded p-3">
          {fields.map(([key, value]) => {
            const changed = entry.changed_fields?.[key]
            return (
              <div key={key}>
                <span className="text-zinc-500">{key.replace(/_/g, ' ')}: </span>
                <span className="font-medium">{String(value ?? '—')}</span>
                {changed && (
                  <span className="text-amber-600 text-xs ml-1">(was: {String(changed.old ?? '—')})</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {members.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-500 uppercase mb-2">
            Additional members ({members.length})
          </h4>
          <div className="space-y-2">
            {members.map((m, i) => (
              <div key={i} className="text-sm bg-zinc-50 rounded p-3">
                {m.member_first_name} {m.member_last_name} — {m.member_email} ({m.member_ownership_pct}%)
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold text-zinc-500 uppercase mb-2">
          Documents ({entry.upload_paths.length})
        </h4>
        {entry.upload_paths.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents uploaded.</p>
        ) : documents === null && !docsError ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading documents…
          </div>
        ) : docsError ? (
          <p className="text-sm text-red-600">{docsError}</p>
        ) : documents!.length === 0 ? (
          // Staff must never see a silently empty list when the client
          // actually uploaded something — that's indistinguishable from
          // "nothing to review" and defeats the whole point of this screen.
          // Found live, 2026-09-20: every real document was filtered out
          // by a since-fixed bug in the ownership check with zero visible
          // sign anything was wrong. This is the safety net for the next
          // time something upstream silently drops a document, whatever
          // the cause.
          <p className="text-sm text-red-600">
            ⚠️ {entry.upload_paths.length} document{entry.upload_paths.length === 1 ? '' : 's'} uploaded but none could be shown — do not confirm without checking with engineering.
          </p>
        ) : (
          <ul className="space-y-1">
            {documents!.map((doc) => (
              <li key={doc.path} className="flex items-center gap-2 text-sm">
                <FileText className="h-3.5 w-3.5 text-zinc-400" />
                {doc.url ? (
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    {doc.file_name} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-zinc-400">{doc.file_name} (unavailable)</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmPanel entry={entry} />
    </div>
  )
}

function ConfirmPanel({ entry }: { entry: OnboardingReviewEntry }) {
  const router = useRouter()
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorLines, setErrorLines] = useState<string[] | null>(null)
  const [result, setResult] = useState<{ account_id: string | null; contact_id: string | null; company_name: string | null; lines: string[]; pending: boolean } | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear a pending delayed refresh if this row unmounts first (e.g. staff
  // collapses it within the 4s window) — an orphaned timer firing against a
  // stale closure was found live, 2026-09-20 round-2 QA: collapsing and
  // re-expanding the row inside the window re-mounts a fresh ConfirmPanel
  // with no `result`, showing the pre-confirm button again even though the
  // submission was already reviewed server-side.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  const handleConfirm = async () => {
    setConfirming(true)
    setError(null)
    setErrorLines(null)
    try {
      const res = await fetch(`/api/onboarding-review/${entry.id}/confirm`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.success) {
        // Surface the real per-step detail, not just the one-line summary —
        // a partial failure (e.g. account created, contact didn't) needs to
        // be actually visible here, not just logged somewhere staff won't
        // see it (2026-09-20, bug-hunter blocker finding).
        setError(data.error || 'Could not confirm this submission.')
        setErrorLines(Array.isArray(data.lines) ? data.lines : null)
        return
      }
      setResult({ account_id: data.account_id, contact_id: data.contact_id, company_name: data.company_name, lines: data.lines || [], pending: !!data.pending })
      // Refresh the list after a delay, not immediately — an instant refresh
      // re-fetches the server list (which now excludes this row) and
      // unmounts it, including the success message we just showed, before
      // staff can actually read it (bug-hunter finding, 2026-09-20: the
      // "Confirmed" banner was disappearing on essentially every successful
      // click). Give it a few seconds to actually be seen first.
      refreshTimerRef.current = setTimeout(() => router.refresh(), 4000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConfirming(false)
    }
  }

  if (result) {
    return (
      <div className="border-t pt-3 space-y-2">
        <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 rounded p-3">
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">
              {result.pending
                ? `Confirmed — setting up ${result.company_name || 'the account'} now.`
                : `Confirmed — ${result.company_name || 'account'} created.`}
            </div>
            <div className="text-xs text-emerald-600 mt-0.5">
              {result.pending
                ? 'The account, Drive folder, and follow-up tasks are being created in the background — usually within a few minutes.'
                : 'Drive folder and follow-up tasks are being set up in the background.'}
            </div>
          </div>
        </div>
        {result.lines.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <pre className="whitespace-pre-wrap mt-1">{result.lines.join('\n')}</pre>
          </details>
        )}
      </div>
    )
  }

  return (
    <div className="border-t pt-3 space-y-2">
      {error && (
        <div className="text-sm text-red-600 space-y-1">
          <p>{error}</p>
          {errorLines && errorLines.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer">Details</summary>
              <pre className="whitespace-pre-wrap mt-1 text-zinc-600">{errorLines.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5"
          disabled={confirming}
        />
        <span>I checked the submitted information and every uploaded document, and it looks correct.</span>
      </label>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={!acknowledged || confirming}
        className="inline-flex items-center gap-2 bg-zinc-900 text-white text-sm px-3 py-1.5 rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-800"
      >
        {confirming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Confirm — create account
      </button>
    </div>
  )
}
