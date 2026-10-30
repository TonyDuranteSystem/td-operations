'use client'

import { formatWhen } from '@/lib/marketing/lead-view'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { localeFor } from '@/lib/marketing/i18n'
import type { SetterNote } from '@/lib/marketing/setter-note'

/**
 * The "Setter's note" (TD Marketing, dev job 9aec66fa, build step 2): at the top of every lead, what the setter decided and why: the outcome, who and when, her note, the ticks
 * from the call, and the latest other notes. Plain labels, not colour alone. Long text wraps. Only people who may read the team's notes are given this block.
 */
export function SetterNoteBlock({ note, ticks, noteDay, zone = 'Europe/Rome' }: { note: SetterNote; ticks: Array<{ item: string; ticked: boolean }> | null; noteDay?: string; /** the zone the viewer reads times in (the same as the rest of the page) */ zone?: string }) {
  const t = useT()
  const loc = localeFor(useLang())
  const fw = (iso: string | null | undefined) => formatWhen(iso, zone, loc)
  const o = note.outcome
  const empty = !o && note.notes.length === 0 && (!ticks || ticks.length === 0)
  // nothing written yet: no frame at all (an empty yellow box only took room and made people look for a note that was not there)
  if (empty) return null
  const badge = !o ? null
    : o.outcome === 'good' ? { text: t('Good'), cls: 'bg-emerald-100 text-emerald-900' }
    : o.outcome === 'not_in_target' ? { text: o.reasonLabel ? t('Not in target: {reason}', { reason: t(o.reasonLabel) }) : t('Not in target'), cls: 'bg-rose-100 text-rose-900' }
    : { text: o.callbackAt ? t('Call back on {when}', { when: fw(o.callbackAt) }) : t('Call back'), cls: 'bg-sky-100 text-sky-900' }
  return (
    <section aria-label={t("Setter's note")} data-tour="lead-note" className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 text-sm" data-testid="setter-note">
      <h3 className="text-sm font-semibold text-amber-900">{t("Setter's note")}</h3>
      {o && badge && (
        <div className="mt-2">
          <p className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>{badge.text}</span><span className="text-xs text-slate-600">{o.by}{o.viaViewAs ? ` ${t('(viewing as)')}` : ''} · {fw(o.at)}</span></p>
          {o.note ? <p className="mt-2 whitespace-pre-wrap break-words text-slate-900" data-testid="setter-note-text">{o.note}</p> : <p className="mt-2 text-slate-500">{t('No note was written with it.')}</p>}
        </div>
      )}
      {ticks && ticks.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-600">{t('What was confirmed on the call')}</p>
          <ul className="mt-1 space-y-0.5">{ticks.map(q => <li key={q.item} className="break-words">{q.ticked ? t('✔ Confirmed:') : t('✘ Not confirmed:')} {q.item}</li>)}</ul>
        </div>
      )}
      {note.notes.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-600">{noteDay ?? t('Other notes')}</p>
          <ul className="mt-1 space-y-1.5">{note.notes.map((n, i) => <li key={`${n.at}-${i}`}><span className="text-xs text-slate-600">{n.by}{n.viaViewAs ? ` ${t('(viewing as)')}` : ''} · {fw(n.at)}</span><p className="whitespace-pre-wrap break-words text-slate-900">{n.text}</p></li>)}</ul>
        </div>
      )}
    </section>
  )
}
