import { formatWhen } from '@/lib/marketing/lead-view'
import type { SetterNote } from '@/lib/marketing/setter-note'

/**
 * The "Setter's note" (TD Marketing, dev job 9aec66fa, build step 2): at the top of every lead, what the setter decided and why: the outcome, who and when, her note, the ticks
 * from the call, and the latest other notes. Plain labels, not colour alone. Long text wraps. Only people who may read the team's notes are given this block.
 */
export function SetterNoteBlock({ note, ticks, noteDay }: { note: SetterNote; ticks: Array<{ item: string; ticked: boolean }> | null; noteDay?: string }) {
  const o = note.outcome
  const empty = !o && note.notes.length === 0 && (!ticks || ticks.length === 0)
  const badge = !o ? null
    : o.outcome === 'good' ? { text: 'Good', cls: 'bg-emerald-100 text-emerald-900' }
    : o.outcome === 'not_in_target' ? { text: `Not in target${o.reasonLabel ? `: ${o.reasonLabel}` : ''}`, cls: 'bg-rose-100 text-rose-900' }
    : { text: `Call back${o.callbackAt ? ` on ${formatWhen(o.callbackAt)}` : ''}`, cls: 'bg-sky-100 text-sky-900' }
  return (
    <section aria-label="Setter's note" data-tour="lead-note" className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 text-sm" data-testid="setter-note">
      <h3 className="text-sm font-semibold text-amber-900">Setter&apos;s note</h3>
      {empty && <p className="mt-2 text-slate-600">Nobody has written a note on this lead yet.</p>}
      {o && badge && (
        <div className="mt-2">
          <p className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>{badge.text}</span><span className="text-xs text-slate-600">{o.by}{o.viaViewAs ? ' (viewing as)' : ''} · {formatWhen(o.at)}</span></p>
          {o.note ? <p className="mt-2 whitespace-pre-wrap break-words text-slate-900" data-testid="setter-note-text">{o.note}</p> : <p className="mt-2 text-slate-500">No note was written with it.</p>}
        </div>
      )}
      {ticks && ticks.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-600">What was confirmed on the call</p>
          <ul className="mt-1 space-y-0.5">{ticks.map(q => <li key={q.item} className="break-words">{q.ticked ? '✔ Confirmed:' : '✘ Not confirmed:'} {q.item}</li>)}</ul>
        </div>
      )}
      {note.notes.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-600">{noteDay ?? 'Other notes'}</p>
          <ul className="mt-1 space-y-1.5">{note.notes.map((n, i) => <li key={`${n.at}-${i}`}><span className="text-xs text-slate-600">{n.by}{n.viaViewAs ? ' (viewing as)' : ''} · {formatWhen(n.at)}</span><p className="whitespace-pre-wrap break-words text-slate-900">{n.text}</p></li>)}</ul>
        </div>
      )}
    </section>
  )
}
