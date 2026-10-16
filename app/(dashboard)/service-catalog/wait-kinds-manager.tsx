'use client'

/**
 * The "Waiting on" list manager (dev job 40235e3c, Antonio 2026-10-16): add, rename, retire and restore the kinds of "waiting on someone
 * else" a service step can have. The kinds us / the client / nobody are built in and shown for reference. Admin-only (the actions check).
 * Inert, with a plain message, until the database step that creates the list has been run.
 */

import { useCallback, useEffect, useState } from 'react'
import { ListChecks, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  addWaitKind,
  loadWaitKindsAdmin,
  renameWaitKind,
  restoreWaitKind,
  retireWaitKind,
  type WaitKindAdminRow,
  type WaitKindResult,
} from './wait-kinds-actions'

const BEHAVIOUR_TEXT: Record<'other' | 'date', string> = {
  other: 'Waits on someone else (shows under Pending; late after the step\'s follow-up days)',
  date: 'Waits for a date (shows under Pending; never late)',
}

export function WaitKindsManager() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [defined, setDefined] = useState(true)
  const [rows, setRows] = useState<WaitKindAdminRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [behaviour, setBehaviour] = useState<'other' | 'date'>('other')
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await loadWaitKindsAdmin()
    if ('error' in res) setError(res.error)
    else {
      setDefined(res.defined)
      setRows(res.rows)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  /** Runs one action; true only when it worked, so the form keeps what was typed when it did not. */
  async function run(key: string, call: () => Promise<WaitKindResult>, done: string): Promise<boolean> {
    setBusy(key)
    try {
      const res = await call()
      if ('error' in res) {
        toast.error(res.error)
        return false
      }
      toast.success(done)
      await reload()
      return true
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Something went wrong. Nothing was changed.')
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border bg-white hover:bg-zinc-50"
      >
        <ListChecks className="h-4 w-4" />
        Waiting-on list
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Waiting-on list">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Who we wait on</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  The choices of a step&apos;s &ldquo;Waiting on&rdquo;. Add a kind (for example &ldquo;The IRS&rdquo;, &ldquo;The bank&rdquo;) and it appears in every step&apos;s
                  dropdown and as a chip on the New Calendar.
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 hover:bg-zinc-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-3 rounded-md border bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
              Always there (built in): <b>Us</b> (our turn), <b>The client</b>, <b>Nobody: job is over</b> (the last step).
            </div>

            {loading && <p className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
            {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}

            {!loading && !error && !defined && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
                The list is not set up yet: the database step that creates it has not been run. Until then the Calendar uses the two kinds it always had
                (an outside office, a date) and nothing here can be changed.
              </p>
            )}

            {!loading && !error && defined && (
              <>
                <ul className="divide-y rounded-md border">
                  {rows.length === 0 && <li className="px-3 py-3 text-sm text-zinc-500">No kinds in the list yet.</li>}
                  {rows.map(r => (
                    <li key={r.slug} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${r.retired ? 'bg-zinc-50 text-zinc-500' : ''}`}>
                      {editing === r.slug ? (
                        <>
                          <input
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            maxLength={60}
                            aria-label={`New name for ${r.name}`}
                            className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                          />
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => run(`rename:${r.slug}`, () => renameWaitKind({ slug: r.slug, name: editName }), 'Renamed.').then(ok => { if (ok) setEditing(null) })}
                            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button type="button" onClick={() => setEditing(null)} className="rounded-md border px-2.5 py-1 text-xs">Cancel</button>
                        </>
                      ) : (
                        <>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">{r.name}{r.retired && <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-600">retired</span>}</div>
                            <div className="text-xs text-zinc-500">
                              {r.behaviour === 'date' ? 'Waits for a date' : 'Waits on someone else'} · used by {r.usedBy} step{r.usedBy === 1 ? '' : 's'}
                              {r.retired && r.usedBy > 0 ? ' (they keep working)' : ''}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setEditing(r.slug); setEditName(r.name) }}
                            className="rounded-md border px-2.5 py-1 text-xs hover:bg-zinc-50"
                          >
                            Rename
                          </button>
                          {r.retired ? (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => run(`restore:${r.slug}`, () => restoreWaitKind({ slug: r.slug }), 'Restored.')}
                              className="rounded-md border px-2.5 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                            >
                              Restore
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => {
                                if (r.usedBy > 0 && !window.confirm(`${r.usedBy} step(s) use "${r.name}". They keep working, but it will no longer be offered for new picks. Retire it?`)) return
                                void run(`retire:${r.slug}`, () => retireWaitKind({ slug: r.slug }), 'Retired.')
                              }}
                              className="rounded-md border px-2.5 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                            >
                              Retire
                            </button>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>

                <form
                  className="mt-4 space-y-2 rounded-md border p-3"
                  onSubmit={e => {
                    e.preventDefault()
                    void run('add', () => addWaitKind({ name, behaviour }), 'Added.').then(ok => { if (ok) setName('') })
                  }}
                >
                  <div className="text-sm font-medium">Add a kind</div>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    maxLength={60}
                    placeholder="For example: The IRS"
                    aria-label="Name of the new kind"
                    className="w-full rounded-md border px-3 py-1.5 text-sm"
                  />
                  <fieldset className="space-y-1 text-sm">
                    <legend className="sr-only">What the new kind means</legend>
                    {(['other', 'date'] as const).map(b => (
                      <label key={b} className="flex items-start gap-2">
                        <input type="radio" name="behaviour" checked={behaviour === b} onChange={() => setBehaviour(b)} className="mt-1" />
                        <span>{BEHAVIOUR_TEXT[b]}</span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="text-xs text-zinc-500">This choice cannot be changed afterwards (it decides which list a job shows in). To change it, add a new kind.</p>
                  <button
                    type="submit"
                    disabled={busy !== null || name.trim().length < 2}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy === 'add' ? 'Adding…' : 'Add kind'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
