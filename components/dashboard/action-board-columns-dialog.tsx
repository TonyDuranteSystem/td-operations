'use client'

/**
 * Notification Center board settings — self-service, no deploy.
 *  • Columns tab: add / rename / reorder / mark the closing stage / delete.
 *  • Card text tab: edit the wording each event shows, and turn an event on/off.
 * Writes to the action_board_columns + action_events catalogs via server
 * actions (audit-logged). See sysdoc notification-center-plan / dev_task 529b26cc.
 */

import { useCallback, useEffect, useState } from 'react'
import { X, ArrowLeft, ArrowRight, Trash2, Plus, CheckCircle2 } from 'lucide-react'
import { WHATS_NEW_DEFAULT_STEPS } from '@/lib/notifications/whats-new-defaults'
import {
  listBoardColumns,
  addBoardColumn,
  renameBoardColumn,
  moveBoardColumn,
  setBoardColumnTerminal,
  removeBoardColumn,
  listActionEvents,
  updateActionEventText,
  setActionEventEnabled,
  listWhatsNewEvents,
  setWhatsNewEventVisible,
  setWhatsNewEventSuggestedStep,
  type BoardColumnRow,
  type ActionEventRow,
  type WhatsNewEventRow,
} from './action-board-actions'

type Tab = 'columns' | 'events' | 'whatsnew'

// Plain-English "when this happens" line per event slug (falls back to the
// catalog display_name). Keeps the editor friendly without extra catalog data.
const EVENT_WHEN: Record<string, string> = {
  itin_wizard_submitted: 'A client submits their ITIN information',
  formation_wizard_submitted: 'A client submits their company-formation information',
  onboarding_wizard_submitted: 'A client finishes onboarding their existing company',
  tax_wizard_submitted: 'A client submits their tax information',
  banking_wizard_submitted: 'A client submits a banking application',
  ss4_signed: 'A client signs the SS-4 (EIN application)',
  tax_return_signed: 'A client signs their tax return',
  itin_number_provided: 'A client gives us their existing ITIN number',
}

export function ManageColumnsDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<Tab>('columns')
  const [rows, setRows] = useState<BoardColumnRow[]>([])
  const [events, setEvents] = useState<ActionEventRow[]>([])
  const [whatsNew, setWhatsNew] = useState<WhatsNewEventRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({}) // live card-text edits per event id

  const load = useCallback(async () => {
    setLoading(true)
    const [cols, evs, wn] = await Promise.all([listBoardColumns(), listActionEvents(), listWhatsNewEvents()])
    if (cols.success && cols.data) setRows(cols.data)
    else if (!cols.success) setError(cols.error || 'Could not load columns')
    if (evs.success && evs.data) setEvents(evs.data)
    if (wn.success && wn.data) setWhatsNew(wn.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (open) {
      setError(null)
      load()
    }
  }, [open, load])

  const run = useCallback(
    async (fn: () => Promise<{ success: boolean; error?: string }>) => {
      setBusy(true)
      setError(null)
      const res = await fn()
      if (!res.success) setError(res.error || 'Action failed')
      await load()
      onChanged()
      setBusy(false)
    },
    [load, onChanged],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white z-10">
          <h2 className="text-sm font-semibold">Board settings</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-1 px-4 pt-3">
          {(['columns', 'events', 'whatsnew'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs font-medium px-3 py-1.5 rounded-t-md ${
                tab === t ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              {t === 'columns' ? 'Columns' : t === 'events' ? 'Card text' : "What's New"}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-2">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{error}</div>
          )}
          {loading && <p className="text-sm text-muted-foreground py-2">Loading…</p>}

          {/* ── COLUMNS ── */}
          {tab === 'columns' && !loading && (
            <>
              <p className="text-xs text-muted-foreground mb-2">
                The stages cards move through. Tick “Closes the card” on the stage that means done — a card moved there
                leaves the board.
              </p>
              {rows.map((col, i) => (
                <div key={col.id} className="flex items-center gap-2 border rounded-lg px-2 py-2">
                  <div className="flex flex-col">
                    <button
                      disabled={busy || i === 0}
                      onClick={() => run(() => moveBoardColumn(col.id, 'left'))}
                      className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30"
                      aria-label="Move left"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      disabled={busy || i === rows.length - 1}
                      onClick={() => run(() => moveBoardColumn(col.id, 'right'))}
                      className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30"
                      aria-label="Move right"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <input
                    defaultValue={col.display_name}
                    disabled={busy}
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      if (v && v !== col.display_name) run(() => renameBoardColumn(col.id, v))
                    }}
                    className="flex-1 text-sm border rounded px-2 py-1"
                  />
                  <label className="flex items-center gap-1 text-[11px] text-zinc-500 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={col.terminal}
                      disabled={busy}
                      onChange={(e) => run(() => setBoardColumnTerminal(col.id, e.target.checked))}
                    />
                    Closes the card
                  </label>
                  <button
                    disabled={busy}
                    onClick={() => run(() => removeBoardColumn(col.id, col.slug))}
                    className="text-zinc-300 hover:text-red-600 disabled:opacity-30"
                    aria-label="Delete column"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-2">
                <input
                  value={newName}
                  disabled={busy}
                  placeholder="New column name…"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newName.trim()) run(() => addBoardColumn(newName)).then(() => setNewName(''))
                  }}
                  className="flex-1 text-sm border rounded px-2 py-1.5"
                />
                <button
                  disabled={busy || !newName.trim()}
                  onClick={() => run(() => addBoardColumn(newName)).then(() => setNewName(''))}
                  className="flex items-center gap-1 text-xs font-medium bg-zinc-900 text-white rounded px-3 py-1.5 disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </button>
              </div>
            </>
          )}

          {/* ── CARD TEXT (events) ── */}
          {tab === 'events' && !loading && (
            <>
              <p className="text-xs text-muted-foreground mb-2">
                When a client does one of these things, a card appears on your board. For each, write what your team
                should do — or switch it off if you don’t want a card. (These moments are fixed; you can’t add new ones here.)
              </p>
              {events.map((ev) => {
                const text = draft[ev.id] ?? ev.next_step
                return (
                  <div key={ev.id} className={`border rounded-lg p-3 ${ev.enabled ? '' : 'opacity-60'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-zinc-800">{EVENT_WHEN[ev.slug] || ev.display_name}</p>
                      <label className="flex items-center gap-1 text-[11px] text-zinc-500 shrink-0 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={ev.enabled}
                          disabled={busy}
                          onChange={(e) => run(() => setActionEventEnabled(ev.id, e.target.checked))}
                        />
                        Show a card
                      </label>
                    </div>
                    <label className="block text-[11px] text-zinc-400 mt-1.5 mb-0.5">What the card should say (what your team does):</label>
                    <input
                      value={text}
                      disabled={busy || !ev.enabled}
                      onChange={(e) => setDraft((d) => ({ ...d, [ev.id]: e.target.value }))}
                      onBlur={() => {
                        const v = (draft[ev.id] ?? '').trim()
                        if (v && v !== ev.next_step) run(() => updateActionEventText(ev.id, v))
                      }}
                      className="w-full text-sm border rounded px-2 py-1"
                    />
                    {ev.enabled && (
                      <div className="mt-2 rounded-md bg-zinc-50 border p-2">
                        <p className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">Card preview</p>
                        <div className="rounded bg-white border p-2 shadow-sm">
                          <p className="text-sm font-medium text-zinc-900">Client name</p>
                          <p className="text-xs text-zinc-600 mt-0.5">{text || '(write what to do above)'}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* ── WHAT'S NEW (per-event show/hide) ── */}
          {tab === 'whatsnew' && !loading && (
            <>
              <p className="text-xs text-muted-foreground mb-2">
                Choose which client events show in the <strong>What&apos;s New</strong> feed (and count toward the purple
                dot), and the suggested to-do that pre-fills when you click <em>Open card</em>. Each one is independent.
              </p>
              {whatsNew.map((ev) => (
                <div
                  key={ev.id}
                  className={`border rounded-lg px-3 py-2 ${ev.visible ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-800">{ev.display_name}</span>
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 shrink-0 whitespace-nowrap cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ev.visible}
                        disabled={busy}
                        onChange={(e) => run(() => setWhatsNewEventVisible(ev.id, e.target.checked))}
                      />
                      Show in What&apos;s New
                    </label>
                  </div>
                  <label className="block text-[11px] text-zinc-400 mt-1.5 mb-0.5">Suggested to-do when you open a card:</label>
                  <input
                    defaultValue={ev.suggested_step ?? WHATS_NEW_DEFAULT_STEPS[ev.slug] ?? ''}
                    disabled={busy}
                    placeholder="e.g. Ship the card to the client"
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      const current = ev.suggested_step ?? WHATS_NEW_DEFAULT_STEPS[ev.slug] ?? ''
                      if (v !== current) run(() => setWhatsNewEventSuggestedStep(ev.id, v))
                    }}
                    className="w-full text-sm border rounded px-2 py-1"
                  />
                </div>
              ))}
            </>
          )}

          <p className="text-[11px] text-zinc-400 pt-1 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> Changes save instantly and apply for everyone.
          </p>
        </div>
      </div>
    </div>
  )
}
