'use client'

/**
 * Team card on a company's page (Team Powers step 5, STAFF ONLY).
 * Read-only list of the portal team logins of THIS company — person, powers, who added them and when, the notice the owner
 * accepted (the saved words), last sign-in, state — plus a SILENT Switch off / Switch on with a reason.
 * No email or message goes to anyone. A person TD switches off cannot be switched back on by the owner.
 * The card draws nothing for a company that has no team logins. It never touches the company's members list.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Users } from 'lucide-react'
import type { CardMember, CardState } from '@/lib/portal/team/crm-view'

interface TeamResponse { ready: boolean; members: CardMember[] }

const STATE_LABEL: Record<CardState, { text: string; cls: string }> = {
  active: { text: 'Active', cls: 'bg-green-100 text-green-800' },
  off_owner: { text: 'Switched off by the owner', cls: 'bg-amber-100 text-amber-800' },
  off_td: { text: 'Switched off by TD', cls: 'bg-red-100 text-red-800' },
  removed: { text: 'Removed', cls: 'bg-gray-100 text-gray-600' },
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET'
}

export function TeamSection({ accountId }: { accountId: string }) {
  const [data, setData] = useState<TeamResponse | null>(null)
  const [openNotice, setOpenNotice] = useState<string | null>(null)
  const [openHistory, setOpenHistory] = useState<string | null>(null)
  const [switching, setSwitching] = useState<{ id: string; action: 'off' | 'on' } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/accounts/${accountId}/team`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not load the team.')
      setData(j as TeamResponse)
    } catch {
      /* the card is a help, never an error on the company page */
      setData(null)
    }
  }, [accountId])

  useEffect(() => {
    void load()
  }, [load])

  async function submitSwitch() {
    if (!switching) return
    if (switching.action === 'off' && !reason.trim()) {
      toast.error('Say why you are switching this person off.')
      return
    }
    setBusy(true)
    try {
      const r = await fetch(`/api/accounts/${accountId}/team/${switching.id}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: switching.action, reason: reason.trim() }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not switch the person. Please try again.')
      toast.success(switching.action === 'off' ? 'Switched off. Nobody was emailed.' : 'Switched on. Nobody was emailed.')
      setSwitching(null)
      setReason('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not switch the person. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!data || data.members.length === 0) return null

  return (
    <div className="bg-white rounded-lg border p-5 space-y-3 lg:col-span-2" data-testid="team-section">
      <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <Users className="h-4 w-4" /> Team logins ({data.members.length})
      </h3>
      <p className="text-xs text-muted-foreground">
        People this company&apos;s owners gave their own sign-in. They are never contacts. Switching someone off or on here is silent: no email is sent, and the reason is saved in the team record.
      </p>
      {!data.ready && (
        <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-800 p-2">
          The team record is not available on this system yet, so this list is read-only and switching is disabled.
        </p>
      )}

      <div className="divide-y">
        {data.members.map((m) => {
          const st = STATE_LABEL[m.state]
          const canSwitch = data.ready && m.state !== 'removed'
          return (
            <div key={m.id} className="py-3 space-y-2" data-testid={`team-member-${m.username}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{m.displayName}</span>
                <span className="text-xs text-muted-foreground">@{m.username}</span>
                <span className={`text-xs rounded-full px-2 py-0.5 ${st.cls}`}>{st.text}</span>
              </div>

              <div className="flex flex-wrap gap-1">
                {m.powers.length === 0 && <span className="text-xs text-muted-foreground">No powers ticked</span>}
                {m.powers.map((p) => (
                  <span key={p} className="text-xs rounded bg-slate-100 text-slate-700 px-2 py-0.5">{p}</span>
                ))}
              </div>

              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>Added {m.addedBy ? `by ${m.addedBy} ` : ''}on {when(m.addedAt)}</div>
                <div>Last sign-in: {m.lastSignIn ? when(m.lastSignIn) : 'Never'}</div>
                {m.switchedOff && (
                  <div>
                    Switched off by {m.switchedOff.by === 'td' ? 'TD' : 'the owner'} on {when(m.switchedOff.at)}
                    {m.switchedOff.reason ? ` — “${m.switchedOff.reason}”` : ''}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" className="text-xs underline text-blue-700" onClick={() => setOpenNotice(openNotice === m.id ? null : m.id)}>
                  {openNotice === m.id ? 'Hide notice signed' : 'Notice signed'}
                </button>
                <button type="button" className="text-xs underline text-blue-700" onClick={() => setOpenHistory(openHistory === m.id ? null : m.id)}>
                  {openHistory === m.id ? 'Hide history' : 'History'}
                </button>
                {canSwitch && m.state === 'active' && (
                  <button type="button" className="text-xs rounded border border-red-300 text-red-700 px-2 py-0.5 hover:bg-red-50" onClick={() => { setSwitching({ id: m.id, action: 'off' }); setReason('') }}>
                    Switch off
                  </button>
                )}
                {canSwitch && (m.state === 'off_owner' || m.state === 'off_td') && (
                  <button type="button" className="text-xs rounded border border-green-300 text-green-700 px-2 py-0.5 hover:bg-green-50" onClick={() => { setSwitching({ id: m.id, action: 'on' }); setReason('') }}>
                    Switch on
                  </button>
                )}
              </div>

              {openNotice === m.id && (
                <div className="rounded border bg-slate-50 p-3 text-xs space-y-1">
                  {m.notice ? (
                    <>
                      <div className="text-muted-foreground">
                        Version {m.notice.version ?? '—'} · accepted {when(m.notice.acceptedAt)}{m.notice.ip ? ` · from ${m.notice.ip}` : ''}
                      </div>
                      {m.notice.text ? <pre className="whitespace-pre-wrap font-sans">{m.notice.text}</pre> : <div>The saved words are not available for this person.</div>}
                    </>
                  ) : (
                    <div>No notice was recorded for this person.</div>
                  )}
                </div>
              )}

              {openHistory === m.id && (
                <ul className="rounded border bg-slate-50 p-3 text-xs space-y-1">
                  {m.history.length === 0 && <li>No record yet.</li>}
                  {m.history.map((h, i) => (
                    <li key={`${h.event}-${h.when}-${i}`}>
                      <span className="font-medium">{h.label}</span> — {h.by}, {when(h.when)}{h.reason ? ` — “${h.reason}”` : ''}
                    </li>
                  ))}
                </ul>
              )}

              {switching?.id === m.id && (
                <div className="rounded border p-3 space-y-2 bg-amber-50/50">
                  {switching.action === 'off' ? (
                    <>
                      <div className="text-xs">
                        Switch <b>{m.displayName}</b> off. They cannot sign in, and the owner <b>cannot</b> switch them back on. No email is sent.
                      </div>
                      <textarea
                        className="w-full rounded border p-2 text-sm"
                        rows={2}
                        maxLength={500}
                        placeholder="Why? (required, saved in the team record)"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </>
                  ) : (
                    <div className="text-xs">
                      Switch <b>{m.displayName}</b> back on. They can sign in again with their own password. No email is sent.
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button type="button" disabled={busy} className="text-xs rounded bg-slate-900 text-white px-3 py-1 disabled:opacity-50 inline-flex items-center gap-1" onClick={submitSwitch}>
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />} Confirm
                    </button>
                    <button type="button" disabled={busy} className="text-xs rounded border px-3 py-1" onClick={() => { setSwitching(null); setReason('') }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
