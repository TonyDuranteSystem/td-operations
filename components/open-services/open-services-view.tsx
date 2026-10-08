'use client'

/**
 * Open services — the page body (N1a C3). Read-only. All state lives in the web address: every control builds a new
 * address and the SERVER re-renders, so search, filters and "Show more" always look at ALL open jobs, never only the
 * rows on screen. Imports only types.ts and params.ts (client-safe) — never the builder, loader or guard.
 */

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  cleanQuery,
  toQueryString,
  withFilterChange,
  withMore,
  withoutMore,
  type OpenServicesParams,
} from '@/lib/open-services/params'
import { PAGE_SIZE, WHO_LABELS, WHO_VALUES, type Group, type Row, type ViewModel, type Who } from '@/lib/open-services/types'

const BASE = '/calendar/open-services'

const CHIP_CLASS: Record<Who, string> = {
  us: 'bg-blue-100 text-blue-800',
  client: 'bg-teal-100 text-teal-800',
  outside: 'bg-rose-100 text-rose-800',
  date: 'bg-zinc-100 text-zinc-700',
  none: 'border border-dashed border-amber-500 bg-amber-50 text-amber-800',
  unset: 'border border-dashed border-zinc-400 text-zinc-500',
}

const GRID = 'md:grid md:grid-cols-[minmax(150px,1.6fr)_minmax(170px,1.6fr)_150px_150px_130px_140px] md:items-center md:gap-3'

function asOfLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(d) + ' ET'
}

function FollowUp({ row }: { row: Row }) {
  switch (row.followUp) {
    case 'late':
      return <span className="font-semibold text-red-700">{row.lateBy} d late</span>
    case 'left':
      return <span className="text-emerald-700">{row.daysLeft} d left</span>
    case 'no-follow-up':
      return <span className="text-zinc-500">no follow-up set</span>
    case 'date-step':
      return <span className="text-zinc-500">waiting for a date</span>
    case 'parked':
      return <span className="text-zinc-500">parked, not counted</span>
    default:
      return <span className="text-zinc-500">not counted</span>
  }
}

function JobRow({ row, showService }: { row: Row; showService: boolean }) {
  return (
    <li className={`border-t px-3 py-3 text-sm ${GRID}`}>
      <div className="flex flex-wrap items-center gap-1.5 font-medium">
        <span>{row.name}</span>
        {row.isPerson && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">person</span>}
        {row.badges.map(b => (
          <span key={b} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">{b}</span>
        ))}
      </div>
      <div className="mt-1 text-zinc-500 md:mt-0">
        {showService && <><b className="font-medium text-foreground">{row.serviceType}</b> · </>}
        {row.stepNo ? `Step ${row.stepNo}: ` : ''}{row.stage || 'no step'}
      </div>
      <div className="mt-2 md:mt-0">
        <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${CHIP_CLASS[row.who]}`}>{WHO_LABELS[row.who]}</span>
      </div>
      <div className="mt-2 tabular-nums md:mt-0">
        {row.sinceLabel ? <>since {row.sinceLabel} · {row.daysHere} d</> : <span className="text-zinc-500">date unknown</span>}
      </div>
      <div className="mt-1 tabular-nums md:mt-0"><FollowUp row={row} /></div>
      <div className="mt-3 md:mt-0">
        <Link
          href={row.href}
          prefetch={false}
          aria-label={`Open workspace for ${row.name}`}
          className="block rounded-md border px-3 py-2 text-center text-sm font-semibold text-blue-700 hover:border-blue-500 md:py-1.5"
        >
          Open workspace
        </Link>
      </div>
    </li>
  )
}

function GroupFactsLine({ group }: { group: Group }) {
  const f = group.facts
  const parts = [`${f.total} job${f.total === 1 ? '' : 's'}`]
  if (f.noDate) parts.push(`${f.noDate} with no step date`)
  if (f.notSet) parts.push('waiting-on not set')
  if (f.parked) parts.push(`${f.parked} paused (blocked, on hold or company not operating)`)
  return <span className="text-sm text-zinc-500">{parts.join(' · ')}</span>
}

export function OpenServicesView({ model, params }: { model: ViewModel; params: OpenServicesParams }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [q, setQ] = useState(params.q)
  // The CLEANED text last sent to the address. The server cleans what it receives (trims, collapses spaces, folds
  // curly apostrophes), so every comparison here is made on the cleaned text — otherwise "Acme " (typed) never equals
  // "Acme" (the address) and the box would be rewritten under the visitor's fingers, eating the space and any letters
  // typed while the page was answering.
  const cq = cleanQuery(q)
  const lastPushed = useRef(params.q)
  // Every search text this page itself has sent to the address. A page answering an EARLIER search can arrive after a
  // later one was already sent; that is still our own text and must never be written back into the box.
  const sent = useRef<Set<string>>(new Set([params.q]))

  function go(next: OpenServicesParams) {
    sent.current.add(next.q)
    start(() => router.replace(`${BASE}${toQueryString(next)}`, { scroll: false }))
  }

  // Every control sends whatever is typed in the box along with its own change, so a click that lands within the
  // search delay can never be undone by the delayed search, and the delayed search can never undo the click.
  function push(next: OpenServicesParams) {
    lastPushed.current = cq
    go({ ...next, q: cq })
  }

  // Keep the box in step with the address only when the address changed from outside (a link, the back button).
  useEffect(() => {
    if (sent.current.has(params.q)) return
    sent.current.add(params.q)
    lastPushed.current = params.q
    setQ(params.q)
  }, [params.q])

  // Debounced search: never fires on first load, and compares with what was LAST SENT (not with the address, which lags
  // behind a slow server render) — otherwise typing and then deleting before the page answers would leave the box
  // empty while the results stay filtered.
  useEffect(() => {
    if (cq === lastPushed.current) return
    const t = setTimeout(() => {
      if (cq === lastPushed.current) return // a control already sent it
      lastPushed.current = cq
      go(withFilterChange(params, { q: cq }))
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cq])

  const toggleWho = (w: Who) =>
    push(withFilterChange(params, { who: params.who.includes(w) ? params.who.filter(x => x !== w) : [...params.who, w] }))

  const showService = model.view === 'who'

  return (
    <div aria-busy={pending}>
      {model.excluded.length > 0 && (
        <div className="mb-3 rounded-lg border bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
          Not shown on this page (they live on other pages):{' '}
          {model.excluded.map((e, i) => (
            <span key={`${i}-${e.label}`}>{i > 0 ? ' · ' : ''}<b className="font-medium text-foreground">{e.label}</b> {e.count}</span>
          ))}
          . <Link href="/calendar" prefetch={false} className="text-blue-700 underline">See Renewals</Link>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Group by</span>
          <div className="inline-flex overflow-hidden rounded-md border text-sm">
            {([['who', 'Waiting on'], ['service', 'Service']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={params.view === v}
                onClick={() => push(withFilterChange(params, { view: v }))}
                className={`px-3 py-1.5 ${params.view === v ? 'bg-blue-600 text-white' : 'bg-white text-zinc-600 hover:bg-zinc-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          aria-pressed={params.late}
          onClick={() => push(withFilterChange(params, { late: !params.late }))}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${params.late ? 'border-blue-600 bg-blue-50 text-blue-800' : 'bg-white text-zinc-700 hover:border-blue-400'}`}
        >
          Late only <span className="ml-1 tabular-nums text-zinc-500">{model.lateChip}</span>
        </button>
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          maxLength={80}
          placeholder="Search a company or person name"
          aria-label="Search a company or person name"
          className="min-w-[220px] flex-1 rounded-md border px-3 py-1.5 text-sm md:max-w-sm"
        />
      </div>

      <div className="flex flex-wrap gap-2 pb-1" role="group" aria-label="Waiting on">
        {WHO_VALUES.map(w => (
          <button
            key={w}
            type="button"
            aria-pressed={params.who.includes(w)}
            onClick={() => toggleWho(w)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${params.who.includes(w) ? 'border-blue-600 bg-blue-50 text-blue-800' : 'bg-white text-zinc-700 hover:border-blue-400'} ${model.chips[w] === 0 ? 'opacity-60' : ''}`}
          >
            {WHO_LABELS[w]} <span className="ml-1 tabular-nums text-zinc-500">{model.chips[w]}</span>
          </button>
        ))}
      </div>
      <p className="py-2 text-xs text-zinc-500">
        Outside office means the IRS, a state or a bank. Late means past the follow-up days set on the step, counted from the last recorded move.
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-3 text-sm text-zinc-600">
        <span><b className="font-semibold text-foreground">{model.shown}</b> of {model.totalOpen} open jobs{model.anyFilter ? ' match' : ''}</span>
        <span><b className="font-semibold text-foreground">{model.late}</b> late</span>
        <span><b className="font-semibold text-foreground">{model.noDate}</b> with no step date</span>
        <span className="ml-auto text-xs text-zinc-500">
          As of {asOfLabel(model.asOf)}{' '}
          <button type="button" onClick={() => start(() => router.refresh())} className="text-blue-700 underline">Refresh</button>
          {pending && <span className="ml-2" role="status">Updating…</span>}
        </span>
      </div>

      {model.warnings.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {model.warnings.map(w => <li key={w}>{w}</li>)}
        </ul>
      )}

      {model.groups.length === 0 && (
        <div className="rounded-lg border px-4 py-8 text-center text-sm text-zinc-500">
          No open jobs match. Clear a filter to see more.
        </div>
      )}

      <div className="space-y-3">
        {model.groups.map(g => (
          <section key={g.key} className="overflow-hidden rounded-lg border bg-white">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-zinc-50 px-3 py-2">
              <h2 className="font-semibold">{g.label}</h2>
              <GroupFactsLine group={g} />
              {g.facts.late > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">{g.facts.late} late</span>}
              {g.collapsed ? (
                <button type="button" onClick={() => push(withMore(params, g.key, PAGE_SIZE))} className="ml-auto rounded-md border bg-white px-3 py-1 text-xs font-medium hover:border-blue-400">
                  Show jobs
                </button>
              ) : (
                params.more.some(([k]) => k === g.key) && g.facts.notSet === g.facts.total && (
                  <button type="button" onClick={() => push(withoutMore(params, g.key))} className="ml-auto rounded-md border bg-white px-3 py-1 text-xs font-medium hover:border-blue-400">
                    Hide jobs
                  </button>
                )
              )}
            </header>
            {!g.collapsed && (
              <>
                <div className={`hidden border-t px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 ${GRID}`} aria-hidden="true">
                  <div>Company or person</div><div>Service and step</div><div>Waiting on</div><div>Here since</div><div>Follow-up</div><div />
                </div>
                <ul>
                  {g.rows.map(r => <JobRow key={r.id} row={r} showService={showService} />)}
                </ul>
                {g.hasMore && !g.capped && (
                  <div className="border-t px-3 py-2">
                    <button type="button" onClick={() => push(withMore(params, g.key, g.nextLimit))} className="rounded-md border bg-white px-3 py-1.5 text-sm font-medium hover:border-blue-400">
                      Show more ({g.total - g.rows.length} remaining)
                    </button>
                  </div>
                )}
                {g.capped && (
                  <div className="border-t px-3 py-2 text-sm text-amber-800" role="status">
                    Showing the first {g.rows.length} of {g.total}. Use the search or a filter to narrow this list — {g.total - g.rows.length} more are not shown.
                  </div>
                )}
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
