/**
 * New Calendar — the page body (dev job 40235e3c). A SERVER component: every chip is a link to a new web address and the
 * server re-renders, so the lists, counts and search always look at ALL open jobs, never only the rows on screen. The only
 * client pieces are the row action (the Wrap-up pop-up) and the refresh button. Read-only in this version.
 * Imports only the client-safe modules (types, params, greeting) — never the builder, the loader or the guard.
 */

import Link from 'next/link'
import {
  BUCKETS,
  BUCKET_HELP,
  BUCKET_LABELS,
  PILL_LABELS,
  WAIT_LABELS,
  type Bucket,
  type CalendarModel,
  type CalendarRow,
  type Pill,
} from '@/lib/new-calendar/types'
import {
  sameText,
  sameTextLoose,
  toQueryString,
  withBucket,
  withMore,
  withService,
  withStep,
  type NewCalendarParams,
} from '@/lib/new-calendar/params'
import { workTodayText } from '@/lib/new-calendar/greeting'
import { RowAction } from '@/components/new-calendar/row-action'
import { RefreshButton } from '@/components/new-calendar/refresh-button'

const BASE = '/new-calendar'
const hrefFor = (p: NewCalendarParams) => `${BASE}${toQueryString(p)}`

const BUCKET_DOT: Record<Bucket, string> = {
  work: 'bg-orange-600',
  pending: 'bg-amber-500',
  other: 'bg-zinc-400',
  closed: 'bg-green-600',
}

const PILL_CLASS: Record<Pill, string> = {
  late: 'bg-red-100 text-red-800',
  work: 'bg-orange-100 text-orange-800',
  pending: 'bg-amber-100 text-amber-800',
  other: 'bg-zinc-100 text-zinc-600',
  closed: 'bg-green-100 text-green-800',
}

const STEP_DOT: Record<string, string> = {
  us: 'bg-orange-600',
  none: 'bg-orange-600',
  client: 'bg-amber-500',
  outside: 'bg-amber-500',
  date: 'bg-amber-500',
  unset: 'bg-zinc-400',
}

function Chip({ href, pressed, dim, dot, title, children }: { href: string; pressed: boolean; dim?: boolean; dot?: string; title?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      title={title}
      aria-current={pressed ? 'true' : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${
        pressed ? 'border-zinc-900 bg-zinc-900 text-white' : 'bg-white text-zinc-800 hover:border-blue-400'
      } ${dim && !pressed ? 'opacity-70' : ''}`}
    >
      {dot && <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />}
      {children}
    </Link>
  )
}

function asOfLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(d) + ' ET'
}

function Days({ row }: { row: CalendarRow }) {
  if (row.bucket === 'closed') return <span className="text-zinc-700">{row.finishedLabel ?? '—'}</span>
  if (row.daysHere === null) return <span className="text-zinc-500">date unknown</span>
  if (row.lateBy !== null) {
    return (
      <span className="font-semibold text-red-700" title={`${row.lateBy} days past the follow-up time set on the step`}>
        {row.daysHere}d <span className="text-xs font-medium">({row.lateBy}d late)</span>
      </span>
    )
  }
  return <span>{row.daysHere}d</span>
}

// The six-column list needs about 950px of content next to the 256px side menu, so it only switches on from 1100px wide windows
// (a floating window or a laptop split view is narrower and gets the stacked card layout, never a clipped or sideways-scrolling one).
const GRID = 'min-[1100px]:grid min-[1100px]:grid-cols-[minmax(160px,1.6fr)_minmax(110px,1fr)_minmax(170px,1.5fr)_135px_minmax(150px,1.4fr)_150px] min-[1100px]:items-center min-[1100px]:gap-3'

function Row({ row }: { row: CalendarRow }) {
  return (
    <li className={`border-t px-3 py-3 text-sm hover:bg-zinc-50 ${GRID}`}>
      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
        <span>{row.name}</span>
        {row.isPerson && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">person</span>}
        {row.badges.map(b => (
          <span key={b} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">{b}</span>
        ))}
      </div>
      <div className="mt-1 text-zinc-700 min-[1100px]:mt-0">{row.serviceType}</div>
      <div className="mt-1 min-[1100px]:mt-0">
        <div>{row.stepNo ? `Step ${row.stepNo}: ` : ''}{row.bucket === 'closed' ? (row.stage || 'Finished') : (row.stage || 'no step')}</div>
        <span className={`mt-1 inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${PILL_CLASS[row.pill]}`}>{PILL_LABELS[row.pill]}</span>
      </div>
      <div className="mt-1 font-mono text-[13px] tabular-nums min-[1100px]:mt-0">
        <span className="font-sans text-zinc-500 min-[1100px]:sr-only">{row.bucket === 'closed' ? 'Finished: ' : 'Days: '}</span><Days row={row} />
      </div>
      <div className="mt-1 text-zinc-700 min-[1100px]:mt-0">{row.next}</div>
      <div className="mt-3 min-[1100px]:mt-0 min-[1100px]:text-right"><RowAction row={row} /></div>
    </li>
  )
}

export function NewCalendarView({ model, params, greeting }: { model: CalendarModel; params: NewCalendarParams; greeting: string }) {
  const closedView = model.active === 'closed'
  const stepView = model.active === null
  const serviceTotal = model.services.reduce((n, s) => n + s.count, 0)

  return (
    <div className="space-y-4 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New Calendar</h1>
        <p className="mt-1 text-sm text-zinc-600">
          {greeting} — <b className="font-semibold text-foreground">{workTodayText(model.workToday)}</b> <span className="text-zinc-500">(open services only)</span>.{' '}
          <Link href="/calendar" prefetch={false} className="text-blue-700 underline">Renewals and annual reports are on the existing Calendar</Link>.
        </p>
      </header>

      <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        This is the new Calendar, being tested. It shows the same jobs as before, sorted into what is on us and what is waiting. For now it only <b>shows</b> things — open a line to work on it.
        Renewals, annual reports and Mark Filed stay on the existing Calendar.
      </div>

      <nav className="flex gap-1 border-b text-sm" aria-label="New Calendar pages">
        <span className="-mb-px border-b-2 border-blue-600 px-3 py-2 font-semibold text-foreground" aria-current="page">
          Open services <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-600">{model.openTotal}</span>
        </span>
        <Link href="/calendar" prefetch={false} className="-mb-px border-b-2 border-transparent px-3 py-2 text-zinc-600 hover:text-foreground">
          Renewals &amp; annual reports →
        </Link>
      </nav>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Lists">
        {BUCKETS.map(b => (
          <Chip key={b} href={hrefFor(withBucket(params, b))} pressed={model.active === b} dim={model.counts[b] === 0} dot={BUCKET_DOT[b]}>
            {BUCKET_LABELS[b]} <span className="font-mono text-xs tabular-nums opacity-80">{model.counts[b]}</span>
          </Chip>
        ))}
        <form action={BASE} method="get" role="search" className="ml-auto flex items-center gap-2">
          {params.b !== 'work' && <input type="hidden" name="b" value={params.b} />}
          {params.s && <input type="hidden" name="s" value={params.s} />}
          {params.s && params.st && <input type="hidden" name="st" value={params.st} />}
          <input
            key={params.q}
            type="search"
            name="q"
            defaultValue={params.q}
            maxLength={80}
            placeholder="Search a company or person"
            aria-label="Search a company or person name"
            className="w-56 rounded-md border bg-white px-3 py-1.5 text-sm"
          />
          <button type="submit" className="rounded-md border bg-white px-3 py-1.5 text-sm font-medium hover:border-blue-400">Search</button>
          {params.q && (
            <Link href={hrefFor({ ...params, q: '', n: 50 })} prefetch={false} className="text-sm text-blue-700 underline">Clear</Link>
          )}
        </form>
      </div>
      {!stepView && <p className="text-xs text-zinc-500">{BUCKET_HELP[model.active as Bucket]}</p>}

      {model.services.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Services">
          {model.services.length > 1 && (
            <Chip href={hrefFor(withService(params, ''))} pressed={params.s === ''}>
              All services <span className="font-mono text-xs tabular-nums opacity-80">{serviceTotal}</span>
            </Chip>
          )}
          {model.services.map(s => (
            <Chip key={s.name} href={hrefFor(withService(params, s.name))} pressed={sameText(params.s, s.name)}>
              {s.name} <span className="font-mono text-xs tabular-nums opacity-80">{s.count}</span>
            </Chip>
          ))}
        </div>
      )}

      {model.steps.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`${params.s} steps`}>
          <span className="text-sm text-zinc-500">{params.s} steps (jobs in all lists):</span>
          {model.steps.map(st => (
            <Chip key={st.name} href={hrefFor(withStep(params, st.name))} pressed={sameTextLoose(params.st, st.name)} dim={st.count === 0} dot={STEP_DOT[st.waitingOn]} title={WAIT_LABELS[st.waitingOn]}>
              {st.name} <span className="font-mono text-xs tabular-nums opacity-80">{st.count}</span>
            </Chip>
          ))}
        </div>
      )}

      {stepView && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
          <span>Every open job on <b>{params.s}</b> · <b>{params.st}</b>, whichever list it is in.</span>
          <Link href={hrefFor(withStep(params, params.st))} prefetch={false} className="text-blue-700 underline">Clear</Link>
        </div>
      )}

      {model.warnings.length > 0 && !closedView && (
        <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {model.warnings.map(w => <li key={w}>{w}</li>)}
        </ul>
      )}

      <div className="overflow-hidden rounded-lg border bg-white">
        <div className={`hidden bg-zinc-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 ${GRID}`} aria-hidden="true">
          <div>Client</div><div>Service</div><div>Step now</div><div>{closedView ? 'Finished' : 'Days'}</div><div>Next step</div><div />
        </div>
        {model.rows.length === 0 ? (
          <div className="border-t px-4 py-8 text-center text-zinc-500">Nothing here right now.</div>
        ) : (
          <ul>
            {model.rows.map(r => <Row key={r.id} row={r} />)}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-600">
        <span>Showing <b className="font-semibold text-foreground">{model.rows.length}</b> of {model.total}</span>
        {model.hasMore && !model.capped && (
          <Link href={hrefFor(withMore(params))} prefetch={false} className="rounded-md border bg-white px-3 py-1.5 font-medium text-foreground hover:border-blue-400">
            Show more ({model.total - model.rows.length} remaining)
          </Link>
        )}
        {model.capped && <span className="text-amber-800" role="status">The first {model.rows.length} are shown. Use the search or a service chip to narrow the list.</span>}
        <span className="ml-auto text-xs text-zinc-500">As of {asOfLabel(model.asOf)} <RefreshButton /></span>
      </div>

      {model.excluded.length > 0 && (
        <div className="rounded-lg border bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
          Not shown here (they live on other pages):{' '}
          {model.excluded.map((e, i) => (
            <span key={`${i}-${e.label}`}>{i > 0 ? ' · ' : ''}<b className="font-medium text-foreground">{e.label}</b> {e.count}</span>
          ))}
          . <Link href="/calendar" prefetch={false} className="text-blue-700 underline">See Renewals</Link>
        </div>
      )}

      <div className="rounded-lg border bg-white p-4 text-sm text-zinc-600">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">How a line moves</h2>
        Each step of a service is marked in its settings as waiting on us, on the client, on an outside office (the IRS, a state, a bank) or on a date.
        A job on a step that is ours is under <b>To work on</b>. A job on a step that waits for someone else is under <b>Pending</b>; if it waits longer than
        the follow-up days set on the step, it comes back to To work on with a red day count. A job on the last step (nobody is waiting) is under To work on
        so someone closes it. Steps with no &ldquo;waiting on&rdquo; setting are listed under <b>Not sorted yet</b> instead of being guessed. When a job is
        finished it stays under <b>Closed</b> for 30 days.
      </div>
    </div>
  )
}
