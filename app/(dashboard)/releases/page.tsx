/**
 * Releases — every release of the CRM, newest first: what changed and what it does, in plain English (dev job 616dc839).
 * Reads the notes compiled into THIS deployment (content/releases/*.json → lib/release/bundled-notes.ts): no database.
 * Staff-only through the dashboard layout. Filters are plain links (no client code): ?tag=new|improved|fixed and ?all=1 to
 * include the behind-the-scenes changes, which are hidden by default.
 */
import Link from 'next/link'
import { ReleaseNoteCard } from '@/components/releases/release-note-card'
import { BUNDLED_NOTES } from '@/lib/release/bundled-notes'
import { OWN_RELEASE_ID } from '@/lib/release/own-release'
import { NOTE_TAG_LABEL, isHiddenNote, isNoteTag, newestFirst, noteDayLabel, type NoteTag } from '@/lib/release/release-notes'

export const dynamic = 'force-dynamic'

const FILTERS: Array<{ tag: NoteTag | null; label: string }> = [
  { tag: null, label: 'Everything' },
  { tag: 'new', label: NOTE_TAG_LABEL.new },
  { tag: 'improved', label: NOTE_TAG_LABEL.improved },
  { tag: 'fixed', label: NOTE_TAG_LABEL.fixed },
]

export default async function ReleasesPage({ searchParams }: { searchParams: Promise<{ tag?: string; all?: string }> }) {
  const sp = await searchParams
  const tag = isNoteTag(sp.tag) ? sp.tag : null
  const showAll = sp.all === '1' || tag === 'behind-the-scenes'

  const everything = newestFirst(BUNDLED_NOTES)
  const hiddenCount = everything.filter(isHiddenNote).length
  const shown = everything.filter(n => (tag ? n.tag === tag : showAll || !isHiddenNote(n)))

  // group by day (the team's time), newest day first
  const days: Array<{ label: string; notes: typeof shown }> = []
  for (const n of shown) {
    const label = noteDayLabel(n.id)
    const last = days[days.length - 1]
    if (last && last.label === label) last.notes.push(n)
    else days.push({ label, notes: [n] })
  }

  const href = (t: NoteTag | null, all: boolean) => {
    const q = new URLSearchParams()
    if (t) q.set('tag', t)
    if (all) q.set('all', '1')
    const s = q.toString()
    return s ? `/releases?${s}` : '/releases'
  }

  return (
    <div className="mx-auto max-w-3xl p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Releases</h1>
        <p className="text-sm text-muted-foreground">
          Every update to the CRM, newest first — what changed and what it does. When a new one is ready, the blue bar at the top offers
          &ldquo;See what&rsquo;s new&rdquo; before you refresh.
        </p>
        {OWN_RELEASE_ID && <p className="mt-1 text-xs text-muted-foreground">You are looking at release <span className="font-mono">{OWN_RELEASE_ID}</span>.</p>}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2" data-release-filters="">
        {FILTERS.map(f => {
          const active = (f.tag ?? null) === (tag === 'behind-the-scenes' ? null : tag)
          return (
            <Link key={f.label} href={href(f.tag, showAll)} className={`rounded-full border px-3 py-1 text-xs font-medium ${active ? 'border-blue-600 bg-blue-600 text-white' : 'hover:bg-muted'}`}>
              {f.label}
            </Link>
          )
        })}
        {hiddenCount > 0 && !tag && (
          <Link href={href(null, !showAll)} className="ml-auto text-xs font-medium text-blue-600 hover:underline">
            {showAll ? 'Hide behind-the-scenes changes' : `Show ${hiddenCount} behind-the-scenes ${hiddenCount === 1 ? 'change' : 'changes'}`}
          </Link>
        )}
      </div>

      {days.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">No release notes here yet.</p>
      ) : (
        <div className="space-y-6">
          {days.map(day => (
            <section key={day.label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{day.label}</h2>
              <div className="space-y-3">{day.notes.map(n => <ReleaseNoteCard key={n.id} note={n} />)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
