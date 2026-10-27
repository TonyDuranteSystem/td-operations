'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { useLeadWindows } from '@/components/marketing/lead-windows-host'
import {
  BOARD_VIEWS, boardCards, cardsInColumn, columnsFor, columnTitle, hiddenCount, parseBoardView,
  type BoardCard, type BoardRole, type BoardView,
} from '@/lib/marketing/board'

const VIEW_KEY = 'tdm_board_view'
const ROLE_LABEL: Record<BoardRole, string> = { seller: "Seller's board", setter: "Setter's board" }
const VIEW_LABEL: Record<BoardView, string> = { pipeline: 'Pipeline', cards: 'Cards', list: 'List' }
const TONE = { ok: 'border-emerald-200 bg-emerald-50 text-emerald-800', warn: 'border-amber-200 bg-amber-50 text-amber-800', info: 'border-sky-200 bg-sky-50 text-sky-800' } as const

function readView(): BoardView {
  try { return parseBoardView(window.localStorage.getItem(VIEW_KEY)) } catch { return 'pipeline' }
}

/**
 * TD Marketing — the lead board (dev job 9aec66fa, Addendum G): Pipeline | Cards | List. A click on a lead opens it in a floating window (the windows are the workspace's, see
 * lead-windows-host.tsx: they work the same on every screen). A person who may use both boards (the team owner) picks one.
 */
export function LeadBoard({ cards, truncated }: { cards: BoardCard[]; truncated: boolean }) {
  const t = useT()
  const { open, role, roles, setRole } = useLeadWindows()
  const [view, setView] = useState<BoardView>('pipeline')
  useEffect(() => { setView(readView()) }, [])
  const pick = (v: BoardView) => {
    setView(v)
    try { window.localStorage.setItem(VIEW_KEY, v) } catch { /* the choice is only a convenience */ }
  }

  const columns = columnsFor(role)
  const hidden = hiddenCount(role, cards)
  const cardButton = (c: BoardCard) => (
    <button key={c.id} type="button" onClick={() => open(c)} data-testid="board-card" data-lead={c.id}
      className={`block w-full rounded-lg border p-3 text-left text-sm shadow-sm hover:border-slate-400 ${c.unread > 0 && c.incomingFrom === 'setter' ? 'border-emerald-500 bg-emerald-50' : c.unread > 0 && c.incomingFrom === 'owner' ? 'animate-pulse border-red-500 bg-red-50' : 'bg-white'}`}
      data-incoming={c.unread > 0 ? c.incomingFrom ?? 'owner' : undefined}>
      <span className="flex items-start justify-between gap-2"><b className="min-w-0 truncate font-medium">{c.name}</b>{c.unread > 0 && <span className={`shrink-0 rounded-full px-1.5 text-[11px] font-semibold text-white ${c.incomingFrom === 'setter' ? 'bg-emerald-600' : 'bg-red-600'}`} data-testid="card-unread" aria-label={t('{n} unread messages', { n: c.unread })}>{c.unread}</span>}{c.existingClient && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-900" title={t('Existing TD client? Check before selling.')}>TD</span>}</span>
      {c.phone && <span className="mt-0.5 block truncate text-xs text-slate-500">{c.phone}</span>}
      {c.note && <span className="mt-1 block text-xs text-slate-700 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">{c.note}</span>}
      {c.chips.length > 0 && <span className="mt-1.5 flex flex-wrap gap-1">{c.chips.map(ch => <span key={ch.key} className={`rounded-full border px-2 py-0.5 text-[11px] ${TONE[ch.tone]}`}>{ch.text}</span>)}</span>}
      <span className="mt-1.5 block truncate text-[11px] text-slate-400">{c.filledIn}{c.ad ? ` · ${c.ad}` : ''}</span>
    </button>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex overflow-hidden rounded-lg border bg-white text-sm" role="group" aria-label={t('View')}>
          {BOARD_VIEWS.map(v => (
            <button key={v} type="button" onClick={() => pick(v)} aria-pressed={view === v} data-testid={`view-${v}`}
              className={`px-4 py-1.5 ${view === v ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{t(VIEW_LABEL[v])}</button>
          ))}
        </div>
        {roles.length > 1 && (
          <div className="flex overflow-hidden rounded-lg border bg-white text-sm" role="group" aria-label={t('Board')} data-testid="role-switch">
            {roles.map(rl => (
              <button key={rl} type="button" onClick={() => setRole(rl)} aria-pressed={role === rl} data-testid={`role-${rl}`}
                className={`px-4 py-1.5 ${role === rl ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{t(ROLE_LABEL[rl])}</button>
            ))}
          </div>
        )}
        <p className="text-xs text-slate-500">{hidden > 0 && view !== 'list' ? t('{n} leads that are not on the board are in the List view.', { n: hidden }) : ''}</p>
      </div>
      {truncated && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Showing the newest 500 leads. Use the Leads page filters to find older ones.')}</p>}

      {view === 'pipeline' && (
        <div className="grid gap-3 overflow-x-auto pb-2" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(${columns.length > 5 ? '11rem' : '15rem'}, 1fr))` }} data-testid="pipeline">
          {columns.map(col => {
            const list = cardsInColumn(role, col.key, cards)
            return (
              <section key={col.key} aria-label={t(col.label)} className="min-w-0 rounded-xl bg-slate-100 p-2" data-column={col.key}>
                <h2 className="px-1 pb-2 text-xs font-semibold text-slate-600">{columnTitle(col, list.length, t)}</h2>
                <div className="space-y-2">{list.length === 0 ? <p className="px-1 py-3 text-xs text-slate-400">{t('Nothing here.')}</p> : list.map(cardButton)}</div>
              </section>
            )
          })}
        </div>
      )}

      {view === 'cards' && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="cards">
          {boardCards(role, cards).length === 0 ? <p className="text-sm text-slate-500">{t('Nothing here.')}</p> : boardCards(role, cards).map(cardButton)}
        </div>
      )}

      {view === 'list' && (
        <div className="overflow-x-auto rounded-xl border bg-white" data-testid="list">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-slate-500"><tr><th className="px-3 py-2">{t('Lead')}</th><th className="px-3">{t('Stage')}</th><th className="px-3">{t('What happened')}</th><th className="px-3">{t('Filled in')}</th><th className="px-3">{t('Picked by')}</th></tr></thead>
            <tbody className="divide-y">
              {[...cards].sort((a, b) => b.arrivedMs - a.arrivedMs).map(c => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => open(c)} data-lead={c.id}>
                  <td className="px-3 py-2 font-medium"><button type="button" onClick={e => { e.stopPropagation(); open(c) }} className="text-left font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500">{c.name}</button>{c.unread > 0 && <span className="ml-2 rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">{c.unread}</span>}<span className="block text-xs font-normal text-slate-500">{c.phone ?? ''}</span></td>
                  <td className="px-3"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t(c.stageLabel)}</span></td>
                  <td className="px-3"><span className="flex flex-wrap gap-1">{c.chips.map(ch => <span key={ch.key} className={`rounded-full border px-2 py-0.5 text-[11px] ${TONE[ch.tone]}`}>{ch.text}</span>)}</span></td>
                  <td className="px-3 text-xs text-slate-500">{c.filledIn}</td>
                  <td className="px-3 text-xs text-slate-500">{c.pickedText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
