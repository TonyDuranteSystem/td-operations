'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatWhen } from '@/lib/marketing/lead-view'
import { AccessPopup, type PopupRole } from '@/components/marketing/access-popup'
import { accessLabel, type Bundles } from '@/lib/marketing/access'
import { roleLabel } from '@/lib/marketing/permission-labels'

interface Member { userId: string; email: string | null; role: 'owner' | 'member'; bundle: string | null; /** what the person holds now: the exact list of ticks */ permissions: string[]; status: 'active' | 'paused'; joinedAt: string | null; lastSignInAt: string | null }
interface Invite { id: string; email: string; role: 'owner' | 'member'; bundle: string | null; permissions: string[]; expiresAt: string; sentBy: string | null }

interface Props { me: string; iAmOwner: boolean; roles: PopupRole[]; grantable: string[]; members: Member[]; invites: Invite[] }

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
const bundlesOf = (roles: PopupRole[]): Bundles => Object.fromEntries(roles.map(r => [r.key, r.permissions]))

/** The Team page's buttons. Every server answer, including each refusal, is shown as the server wrote it. */
export function TeamManager({ me, iAmOwner, roles, grantable, members, invites }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [link, setLink] = useState<{ email: string; url: string; expiresAt: string } | null>(null)
  const [popup, setPopup] = useState<{ mode: 'invite' } | { mode: 'edit'; member: Member } | null>(null)
  const bundles = bundlesOf(roles)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  async function call(url: string, init: RequestInit, fallback: string): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || fallback)
      return { ok: true, data }
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : fallback)
      return { ok: false, data: {} }
    } finally {
      setBusy(false)
    }
  }

  async function invite(v: { email: string; permissions: string[] }) {
    const r = await call('/api/marketing/team/members', { method: 'POST', body: JSON.stringify({ email: v.email, bundle: null, permissions: v.permissions }) }, 'Could not create the invitation. Please try again.')
    if (r.ok) {
      setLink({ email: String(r.data.email ?? v.email), url: String(r.data.inviteUrl), expiresAt: String(r.data.expiresAt) })
      setPopup(null)
      router.refresh()
    }
  }
  async function patch(userId: string, body: Record<string, unknown>, message: string) {
    const r = await call(`/api/marketing/team/members/${userId}`, { method: 'PATCH', body: JSON.stringify(body) }, 'Could not save. Please try again.')
    if (r.ok) { setDone(message); setPopup(null); router.refresh() }
  }
  async function remove(userId: string) {
    const r = await call(`/api/marketing/team/members/${userId}`, { method: 'DELETE' }, 'Could not remove this person. Please try again.')
    if (r.ok) { setDone('Removed. Their login is closed.'); setConfirmRemove(null); router.refresh() }
  }
  async function cancelInvite(id: string) {
    const r = await call(`/api/marketing/team/invites/${id}`, { method: 'DELETE' }, 'Could not cancel the invitation. Please try again.')
    if (r.ok) { setDone('Invitation cancelled.'); router.refresh() }
  }
  return (
    <div className="mt-4 space-y-6">
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      {done && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</p>}

      <section className="rounded-xl border bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold text-slate-600">Invite someone</h2><p className="mt-1 text-xs text-slate-500">Pick what they can see and do. You get a one-time link to send them yourself.</p></div>
          <button className={`${btn} shrink-0 bg-slate-900 text-white`} disabled={busy} onClick={() => { setError(null); setPopup({ mode: 'invite' }) }} data-testid="open-invite">Invite someone</button>
        </div>
      </section>

      {link && (
        <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm" aria-label="Invitation link">
          <p className="font-medium">Invitation for {link.email}</p>
          <p className="mt-1 text-slate-700">Send this link to them. It is shown only now and cannot be shown again (you can cancel it and make a new one). It expires {formatWhen(link.expiresAt)}.</p>
          <input readOnly className="mt-3 w-full rounded-lg border bg-white px-3 py-2 text-xs" value={link.url} onFocus={e => e.currentTarget.select()} aria-label="Invitation link" />
          <div className="mt-3 flex gap-2">
            <button className={btn} onClick={() => { void navigator.clipboard?.writeText(link.url).then(() => setDone('Link copied.')).catch(() => setError('Could not copy. Select the link and copy it.')) }}>Copy link</button>
            <button className={btn} onClick={() => setLink(null)}>Hide</button>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-slate-600">People on the team ({members.length})</h2>
        <ul className="mt-2 space-y-2">
          {members.map(m => {
            const mine = m.userId === me
            const canAct = !mine && m.role !== 'owner'
            return (
              <li key={m.userId} className="rounded-xl border bg-white p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.email ?? 'Unknown login'}{mine && <span className="ml-2 text-xs text-slate-400">(you)</span>}</p>
                    <p className="text-slate-500">{m.role === 'owner' ? 'Team owner' : accessLabel(m.permissions, bundles)}</p>
                    <p className="text-xs text-slate-400">{m.lastSignInAt ? `Last seen ${formatWhen(m.lastSignInAt)}` : m.joinedAt ? 'Has not signed in yet' : ''}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${m.status === 'paused' ? 'bg-amber-100 text-amber-900' : 'bg-slate-100'}`}>{m.status === 'paused' ? 'Paused' : 'Active'}</span>
                </div>
                {canAct && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className={btn} disabled={busy} onClick={() => { setError(null); setPopup({ mode: 'edit', member: m }) }} data-testid="change-access" aria-label={`Change access for ${m.email ?? 'this person'}`}><span aria-hidden="true">⚙ </span>Change access</button>
                    {m.status === 'active'
                      ? <button className={btn} disabled={busy} onClick={() => patch(m.userId, { action: 'pause' }, 'Paused. They are locked out on their next click.')}>Pause</button>
                      : <button className={btn} disabled={busy} onClick={() => patch(m.userId, { action: 'resume' }, 'Resumed.')}>Resume</button>}
                    {confirmRemove === m.userId
                      ? <>
                          <button className={`${btn} border-rose-600 bg-rose-600 text-white`} disabled={busy} onClick={() => remove(m.userId)}>Yes, remove</button>
                          <button className={btn} disabled={busy} onClick={() => setConfirmRemove(null)}>Keep</button>
                        </>
                      : <button className={`${btn} text-rose-700`} disabled={busy} onClick={() => setConfirmRemove(m.userId)}>Remove</button>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-600">Invitations waiting ({invites.length})</h2>
        {invites.length === 0 ? <p className="mt-2 text-sm text-slate-500">None. An invitation stays here until the person uses it, you cancel it, or it expires.</p> : (
          <ul className="mt-2 space-y-2">
            {invites.map(i => (
              <li key={i.id} className="flex items-center justify-between gap-3 rounded-xl border bg-white p-4 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{i.email}</p>
                  <p className="text-slate-500">{i.role === 'owner' ? 'Team owner' : i.bundle ? roleLabel(i.bundle) : accessLabel(i.permissions, bundles)} · expires {formatWhen(i.expiresAt)}</p>
                </div>
                {(iAmOwner || i.role !== 'owner') && <button className={`${btn} shrink-0`} disabled={busy} onClick={() => cancelInvite(i.id)}>Cancel</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {popup && (
        <AccessPopup
          mode={popup.mode} personName={popup.mode === 'edit' ? (popup.member.email ?? 'this person') : undefined}
          roles={roles} grantable={grantable} initial={popup.mode === 'edit' ? popup.member.permissions : []}
          busy={busy} error={error} onCancel={() => { setPopup(null); setError(null) }}
          onSubmit={v => popup.mode === 'invite' ? invite(v) : patch(popup.member.userId, { action: 'access', bundle: null, permissions: v.permissions }, 'Access saved. It takes effect on their next click.')}
        />
      )}
    </div>
  )
}
