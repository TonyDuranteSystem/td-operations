'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatWhen } from '@/lib/marketing/lead-view'
import { InviteEmailPanel } from '@/components/marketing/invite-email-panel'
import { AccessPopup, type PopupRole } from '@/components/marketing/access-popup'
import { accessLabel, type Bundles } from '@/lib/marketing/access'
import { roleLabel } from '@/lib/marketing/permission-labels'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { localeFor, tAccessLabel } from '@/lib/marketing/i18n'

interface Member { userId: string; email: string | null; role: 'owner' | 'member'; bundle: string | null; /** what the person holds now: the exact list of ticks */ permissions: string[]; status: 'active' | 'paused'; joinedAt: string | null; lastSignInAt: string | null }
interface Invite { id: string; email: string; role: 'owner' | 'member'; bundle: string | null; permissions: string[]; expiresAt: string; sentBy: string | null; emailedAt?: string | null }

interface Props { me: string; iAmOwner: boolean; /** Antonio (a CRM admin) — the only one who may make a reset link for a team owner */ iAmAdmin: boolean; /** where the team signs in: the workspace's own address */ workspaceUrl: string; roles: PopupRole[]; grantable: string[]; members: Member[]; invites: Invite[] }

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
const bundlesOf = (roles: PopupRole[]): Bundles => Object.fromEntries(roles.map(r => [r.key, r.permissions]))

/** The Team page's buttons. Every server answer, including each refusal, is shown as the server wrote it. */
export function TeamManager({ me, iAmOwner, iAmAdmin, workspaceUrl, roles, grantable, members, invites }: Props) {
  const router = useRouter()
  const t = useT()
  const loc = localeFor(useLang())
  const fw = (iso: string | null | undefined) => formatWhen(iso, 'Europe/Rome', loc)
  const tLabel = (s: string) => tAccessLabel(t, s)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [link, setLink] = useState<{ kind: 'invite' | 'reset'; email: string; url: string; expiresAt: string } | null>(null)
  const [popup, setPopup] = useState<{ mode: 'invite' } | { mode: 'edit'; member: Member } | null>(null)
  const bundles = bundlesOf(roles)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  async function call(url: string, init: RequestInit, fallback: string): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error ? t((data as { error: string }).error) : fallback)
      return { ok: true, data }
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : fallback)
      return { ok: false, data: {} }
    } finally {
      setBusy(false)
    }
  }

  async function invite(v: { email: string; permissions: string[] }) {
    const r = await call('/api/marketing/team/members', { method: 'POST', body: JSON.stringify({ email: v.email, bundle: null, permissions: v.permissions }) }, t('Could not create the invitation. Please try again.'))
    if (r.ok) {
      setLink({ kind: 'invite', email: String(r.data.email ?? v.email), url: String(r.data.inviteUrl), expiresAt: String(r.data.expiresAt) })
      setPopup(null)
      router.refresh()
    }
  }
  async function patch(userId: string, body: Record<string, unknown>, message: string) {
    const r = await call(`/api/marketing/team/members/${userId}`, { method: 'PATCH', body: JSON.stringify(body) }, t('Could not save. Please try again.'))
    if (r.ok) { setDone(message); setPopup(null); router.refresh() }
  }
  async function remove(userId: string) {
    const r = await call(`/api/marketing/team/members/${userId}`, { method: 'DELETE' }, t('Could not remove this person. Please try again.'))
    if (r.ok) { setDone(t('Removed. Their login is closed.')); setConfirmRemove(null); router.refresh() }
  }
  async function resetPassword(userId: string, email: string | null) {
    const r = await call(`/api/marketing/team/members/${userId}/reset`, { method: 'POST' }, t('Could not make the reset link. Please try again.'))
    if (r.ok) setLink({ kind: 'reset', email: String(r.data.email ?? email ?? ''), url: String(r.data.resetUrl), expiresAt: String(r.data.expiresAt) })
  }
  function copy(url: string) {
    void navigator.clipboard?.writeText(url).then(() => setDone(t('Link copied.'))).catch(() => setError(t('Could not copy. Select the link and copy it.')))
  }
  async function cancelInvite(id: string) {
    const r = await call(`/api/marketing/team/invites/${id}`, { method: 'DELETE' }, t('Could not cancel the invitation. Please try again.'))
    if (r.ok) { setDone(t('Invitation cancelled.')); router.refresh() }
  }
  return (
    <div className="mt-4 space-y-6">
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      {done && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</p>}

      <section className="rounded-xl border bg-white p-4" data-testid="workspace-link">
        <h2 className="text-sm font-semibold text-slate-600">{t('Workspace link')}</h2>
        <p className="mt-1 text-xs text-slate-500">{t('Send this link to anyone on the team. They sign in with their own email and password.')}</p>
        <div className="mt-3 flex gap-2">
          <input readOnly className="min-w-0 flex-1 rounded-lg border bg-slate-50 px-3 py-2 text-xs" value={workspaceUrl} onFocus={e => e.currentTarget.select()} aria-label={t('Workspace link')} />
          <button className={`${btn} shrink-0`} onClick={() => copy(workspaceUrl)} data-testid="copy-workspace-link">{t('Copy link')}</button>
        </div>
      </section>

      <section className="rounded-xl border bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold text-slate-600">{t('Invite someone')}</h2><p className="mt-1 text-xs text-slate-500">{t('Pick what they can see and do. You get a one-time link to send them yourself.')}</p></div>
          <button className={`${btn} shrink-0 bg-slate-900 text-white`} disabled={busy} onClick={() => { setError(null); setPopup({ mode: 'invite' }) }} data-testid="open-invite">{t('Invite someone')}</button>
        </div>
      </section>

      {link && (
        <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm" aria-label={link.kind === 'reset' ? t('Password reset link') : t('Invitation link')} data-testid={link.kind === 'reset' ? 'reset-link-card' : 'invite-link-card'}>
          <p className="font-medium">{link.kind === 'reset' ? t('Password reset link for {email}', { email: link.email }) : t('Invitation for {email}', { email: link.email })}</p>
          <p className="mt-1 text-slate-700">{link.kind === 'reset'
            ? t('Send this link to them. It is shown only now and cannot be shown again (you can make a new one). It works once and expires {when}.', { when: fw(link.expiresAt) })
            : t('Send this link to them. It is shown only now and cannot be shown again (you can cancel it and make a new one). It expires {when}.', { when: fw(link.expiresAt) })}</p>
          <input readOnly className="mt-3 w-full rounded-lg border bg-white px-3 py-2 text-xs" value={link.url} onFocus={e => e.currentTarget.select()} aria-label={link.kind === 'reset' ? t('Password reset link') : t('Invitation link')} />
          <div className="mt-3 flex gap-2">
            <button className={btn} onClick={() => copy(link.url)}>{t('Copy link')}</button>
            <button className={btn} onClick={() => setLink(null)}>{t('Hide')}</button>
          </div>
          {link.kind === 'invite' && <InviteEmailPanel url={link.url} endpoint="/api/marketing/team/invites/email" t={t} />}
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-slate-600">{t('People on the team ({n})', { n: members.length })}</h2>
        <ul className="mt-2 space-y-2">
          {members.map(m => {
            const mine = m.userId === me
            const canAct = !mine && m.role !== 'owner'
            // a reset link: for an active person other than yourself; for a team owner only Antonio (the server decides again)
            const canReset = !mine && m.status === 'active' && (m.role !== 'owner' || iAmAdmin)
            return (
              <li key={m.userId} className="rounded-xl border bg-white p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.email ?? t('Unknown login')}{mine && <span className="ml-2 text-xs text-slate-400">{t('(you)')}</span>}</p>
                    <p className="text-slate-500">{m.role === 'owner' ? t('Team owner') : tLabel(accessLabel(m.permissions, bundles))}</p>
                    <p className="text-xs text-slate-400">{m.lastSignInAt ? t('Last seen {when}', { when: fw(m.lastSignInAt) }) : m.joinedAt ? t('Has not signed in yet') : ''}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${m.status === 'paused' ? 'bg-amber-100 text-amber-900' : 'bg-slate-100'}`}>{m.status === 'paused' ? t('Paused') : t('Active')}</span>
                </div>
                {(canAct || canReset) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {canReset && <button className={btn} disabled={busy} onClick={() => resetPassword(m.userId, m.email)} data-testid="reset-password" aria-label={t('Reset password for {name}', { name: m.email ?? t('this person') })}>{t('Reset password')}</button>}
                    {canAct && <button className={btn} disabled={busy} onClick={() => { setError(null); setPopup({ mode: 'edit', member: m }) }} data-testid="change-access" aria-label={t('Change access for {name}', { name: m.email ?? t('this person') })}><span aria-hidden="true">⚙ </span>{t('Change access')}</button>}
                    {canAct && (m.status === 'active'
                      ? <button className={btn} disabled={busy} onClick={() => patch(m.userId, { action: 'pause' }, t('Paused. They are locked out on their next click.'))}>{t('Pause')}</button>
                      : <button className={btn} disabled={busy} onClick={() => patch(m.userId, { action: 'resume' }, t('Resumed.'))}>{t('Resume')}</button>)}
                    {canAct && (confirmRemove === m.userId
                      ? <>
                          <button className={`${btn} border-rose-600 bg-rose-600 text-white`} disabled={busy} onClick={() => remove(m.userId)}>{t('Yes, remove')}</button>
                          <button className={btn} disabled={busy} onClick={() => setConfirmRemove(null)}>{t('Keep')}</button>
                        </>
                      : <button className={`${btn} text-rose-700`} disabled={busy} onClick={() => setConfirmRemove(m.userId)}>{t('Remove')}</button>)}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-600">{t('Invitations waiting ({n})', { n: invites.length })}</h2>
        {invites.length === 0 ? <p className="mt-2 text-sm text-slate-500">{t('None. An invitation stays here until the person uses it, you cancel it, or it expires.')}</p> : (
          <ul className="mt-2 space-y-2">
            {invites.map(i => (
              <li key={i.id} className="flex items-center justify-between gap-3 rounded-xl border bg-white p-4 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{i.email}</p>
                  <p className="text-slate-500">{t('{who} · expires {when}', { who: i.role === 'owner' ? t('Team owner') : tLabel(i.bundle ? roleLabel(i.bundle) : accessLabel(i.permissions, bundles)), when: fw(i.expiresAt) })}{i.emailedAt ? ` · ${t('emailed {when}', { when: fw(i.emailedAt) })}` : ''}</p>
                </div>
                {(iAmOwner || i.role !== 'owner') && <button className={`${btn} shrink-0`} disabled={busy} onClick={() => cancelInvite(i.id)}>{t('Cancel')}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {popup && (
        <AccessPopup
          mode={popup.mode} personName={popup.mode === 'edit' ? (popup.member.email ?? t('this person')) : undefined}
          roles={roles} grantable={grantable} initial={popup.mode === 'edit' ? popup.member.permissions : []}
          busy={busy} error={error} onCancel={() => { setPopup(null); setError(null) }}
          onSubmit={v => popup.mode === 'invite' ? invite(v) : patch(popup.member.userId, { action: 'access', bundle: null, permissions: v.permissions }, t('Access saved. It takes effect on their next click.'))}
        />
      )}
    </div>
  )
}
