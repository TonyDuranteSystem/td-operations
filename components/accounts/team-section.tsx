'use client'

/**
 * Team card on a company's page (Team Powers step 5, STAFF ONLY).
 * Read-only list of the portal team logins of THIS company — person, powers, who added them and when, the notice the owner
 * accepted (the saved words), last sign-in, state — plus a SILENT Switch off / Switch on with a reason.
 * Below the people, a read-only list of which owners share their personal documents with which login, and whether that login can see them now.
 * No email or message goes to anyone. A person TD switches off cannot be switched back on by the owner.
 * The card draws nothing for a company that has no team logins. It never touches the company's members list.
 * A load that FAILS is said so ("could not load") — never drawn as "no team logins" (the card would simply vanish).
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Users } from 'lucide-react'
import { teamCardMode, type CardMember, type CardState } from '@/lib/portal/team/crm-view'
import { SHARING_STATUS_TEXT, sharingBlockMode, type SharingLine } from '@/lib/portal/team/sharing-list'

interface TeamResponse { ready: boolean; historyAvailable?: boolean; members: CardMember[]; sharing?: { available: boolean; lines: SharingLine[] } }

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
  const [loadFailed, setLoadFailed] = useState(false)
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
      setLoadFailed(false)
    } catch {
      // Keep what was on screen (it may be out of date) and say the load failed; never turn a failure into "no team logins".
      setLoadFailed(true)
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
      // A switch can half-succeed (switched off, but the sign-in block failed): show the real state, not the old one.
      void load()
    } finally {
      setBusy(false)
    }
  }

  const mode = teamCardMode({ hasData: !!data, memberCount: data?.members.length ?? 0, failed: loadFailed })
  if (mode === 'hidden' || (mode === 'list' && !data)) return null
  if (mode === 'failed') {
    return (
      <div className="bg-white rounded-lg border p-5 space-y-2 lg:col-span-2" data-testid="team-section-failed">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <Users className="h-4 w-4" /> Team logins
        </h3>
        <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-800 p-2">
          Could not load this company&apos;s team logins right now — this does NOT mean there are none. Nothing was changed.{' '}
          <button onClick={() => void load()} className="underline" data-testid="team-section-retry">Try again</button>
        </p>
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="bg-white rounded-lg border p-5 space-y-3 lg:col-span-2" data-testid="team-section">
      <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <Users className="h-4 w-4" /> Team logins ({data.members.length})
      </h3>
      <p className="text-xs text-muted-foreground">
        People this company&apos;s owners gave their own sign-in. They are never contacts. Switching someone off or on here is silent: no email is sent, and the reason is saved in the team record.
      </p>
      {loadFailed && (
        <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-800 p-2" data-testid="team-section-stale">
          Could not refresh this list — what you see may be out of date.{' '}
          <button onClick={() => void load()} className="underline">Try again</button>
        </p>
      )}
      {!data.ready && (
        <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-800 p-2">
          The team record is not available on this system yet, so this list is read-only and switching is disabled.
        </p>
      )}
      {data.ready && data.historyAvailable === false && (
        <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-800 p-2" data-testid="team-section-history-unreadable">
          The history of these people could not be read just now, so the lines below may be missing. Switching off and on still works.{' '}
          <button onClick={() => void load()} className="underline">Try again</button>
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
                <div>Last sign-in: {m.lastSignInUnreadable ? 'could not be checked' : m.lastSignIn ? when(m.lastSignIn) : 'Never'}</div>
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

      <SharingBlock sharing={data.sharing} onRetry={() => void load()} />
    </div>
  )
}

/**
 * Who shares their own personal documents (passport, ID) with which team login — the CURRENT list, with whether the login can see them now.
 * A list that could not be read says so; it is never drawn as "nobody shares".
 */
function SharingBlock({ sharing, onRetry }: { sharing: TeamResponse['sharing']; onRetry: () => void }) {
  if (!sharing) return null // an older server answered without the sharing list: draw nothing rather than a wrong "nobody"
  const mode = sharingBlockMode({ available: sharing.available, lineCount: sharing.lines.length })
  return (
    <div className="border-t pt-3 space-y-2" data-testid="sharing-block">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Personal documents shared with team logins</h4>
      <p className="text-xs text-muted-foreground">
        An owner can let one team login see their own personal papers (such as a passport or ID). This is who shares with whom right now, and whether that login can really see them.
      </p>
      {mode === 'unavailable' && (
        <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-800 p-2" data-testid="sharing-unavailable">
          Could not read the sharing list right now — this does NOT mean nobody shares. Nothing was changed.{' '}
          <button onClick={onRetry} className="underline">Try again</button>
        </p>
      )}
      {mode === 'empty' && (
        <p className="text-xs" data-testid="sharing-empty">Nobody. No owner has shared their personal documents with a team login.</p>
      )}
      {mode === 'list' && (
        <ul className="divide-y rounded border" data-testid="sharing-list">
          {sharing.lines.map((l: SharingLine) => (
            <li key={`${l.loginId}-${l.ownerContactId}`} className="p-2 text-xs space-y-0.5" data-testid={`sharing-line-${l.loginUsername || l.loginId}`}>
              <div>
                <span className="font-medium">{l.ownerName}</span> shares their personal documents with <span className="font-medium">{l.loginName}</span>
                {l.loginUsername ? <span className="text-muted-foreground"> @{l.loginUsername}</span> : null}
              </div>
              <div className="text-muted-foreground">Since {when(l.since)}</div>
              <div className={l.status === 'can_see' ? 'text-green-700' : 'text-amber-700'}>{SHARING_STATUS_TEXT[l.status]}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
