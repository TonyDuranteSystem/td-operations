'use client'

/**
 * The New Calendar's "What's New" tab: the SAME What's New as Portal Chats (client-action notes: payments, signatures, submissions…),
 * inside the Calendar. A list of the clients that have something new, newest first; choose one and the very same per-client panel
 * opens (its notes, "Open" to the record, the workflow's own buttons, "Mark handled"). Nothing here is a copy of the logic.
 *
 * The panel is used with its To-Do-card button and money actions OFF: the Calendar is the to-do list and has no separate to-do cards
 * for people (Antonio, 2026-10-14). Staff only (the route refuses everyone else).
 */

import { useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { ThreadWhatsNewPanel, EVENT_KEY_LABELS } from '@/components/portal-chats/thread-whats-new-panel'
import { useWhatsNewSummary } from '@/components/whats-new/use-whats-new-summary'
import type { SummaryClient } from '@/lib/notifications/whats-new-summary'

function timeAgo(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : formatDistanceToNow(d, { addSuffix: true })
}

export function WhatsNewTab() {
  const { data, error, isLoading, isFetching, refetch } = useWhatsNewSummary()
  const [selected, setSelected] = useState<SummaryClient | null>(null)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-600">
          <Sparkles className="mr-1 inline h-4 w-4 text-purple-600" aria-hidden="true" />
          What your clients just did (payments, signatures, forms, documents). It is the same list as in Portal Chats, here in the Calendar.
        </p>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1 rounded-md border bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
        </button>
      </div>

      {error && !data && (
        <p className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error instanceof Error ? error.message : "Could not read What's New."}
        </p>
      )}
      {error && data && <p className="text-xs text-red-600">Could not refresh: {error instanceof Error ? error.message : 'try again'}. Showing the last read.</p>}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {data && data.clients.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border bg-white py-12 text-center">
          <CheckCircle2 className="mb-2 h-9 w-9 text-zinc-200" />
          <p className="text-sm font-medium text-zinc-500">Nothing new</p>
          <p className="text-xs text-zinc-400">Client actions show up here as soon as they happen.</p>
        </div>
      )}

      {data && data.clients.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <div className="overflow-hidden rounded-lg border bg-white">
            <div className="border-b bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
              <b className="font-semibold text-foreground">{data.total}</b> new from <b className="font-semibold text-foreground">{data.clientCount}</b> client{data.clientCount === 1 ? '' : 's'}
              {data.truncated && <span className="text-amber-700"> · showing the newest {data.clients.length}</span>}
            </div>
            <ul className="max-h-[70vh] divide-y overflow-y-auto" aria-label="Clients with something new">
              {data.clients.map((c) => {
                const label = (c.latestEventKey && EVENT_KEY_LABELS[c.latestEventKey]) || c.latestEventKey
                const active = selected?.key === c.key
                return (
                  <li key={c.key}>
                    <button
                      type="button"
                      onClick={() => setSelected(c)}
                      aria-current={active ? 'true' : undefined}
                      className={`flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-zinc-50 ${active ? 'bg-purple-50' : ''}`}
                    >
                      <span className="mt-0.5 shrink-0 rounded-full bg-purple-600 px-2 py-0.5 font-mono text-xs font-semibold text-white">{c.count}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold" title={c.name}>{c.name}</span>
                        <span className="block text-[11px] text-zinc-500">
                          {label ? <span className="mr-1 rounded border bg-zinc-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-zinc-500">{label}</span> : null}
                          {timeAgo(c.latestAt)}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-600">{c.latestText}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="flex min-h-[320px] flex-col overflow-hidden rounded-lg border bg-white lg:h-[70vh]">
            {selected ? (
              <>
                <div className="border-b bg-zinc-50 px-4 py-2 text-sm font-semibold">{selected.name}</div>
                <ThreadWhatsNewPanel
                  key={selected.key}
                  accountId={selected.accountId}
                  contactId={selected.contactId}
                  cardAccountId={selected.accountId}
                  showMoneyActions={false}
                  openWorkspaceInWindow
                  workspaceTitle={selected.name}
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-zinc-400">Choose a client on the left to see what they did.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
