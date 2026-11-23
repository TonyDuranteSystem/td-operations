'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { buildHandoverMessage } from '@/lib/portal/team/handover'
import { CAPABILITY_GROUPS, CAPABILITY_LABELS, describeCapabilities, type NoticeLang } from '@/lib/portal/team/capability-labels'
import { buildNotice, noticeCheckboxLabel, NOTICE_VERSION, type Notice, type NoticeMode } from '@/lib/portal/team/notice'
import { buildPersonalDocsNotice, personalDocsCheckboxLabel, PERSONAL_DOCS_NOTICE_VERSION } from '@/lib/portal/team/personal-docs-notice'

// The tick list (labels, hints, groups and the options that hang under a tick) lives in lib/portal/team/capability-labels.ts,
// so this screen, the notice the owner accepts and the emails to the other owners can never drift apart.

/** Ticking/unticking one box; unticking a main box also clears the options that hang under it. */
export function toggleWithChildren(c: Record<string, boolean>, key: string): Record<string, boolean> {
  const next = { ...c, [key]: !c[key] }
  if (!next[key]) for (const o of CAPABILITY_LABELS) if (o.parent === key) next[o.key] = false
  return next
}

/** True when `after` ticks a power that `before` did not (adding a power needs the owner's confirmation). */
export function addsPower(before: Record<string, boolean>, after: Record<string, boolean>): boolean {
  return Object.keys(after).some(k => after[k] === true && before[k] !== true)
}

export type TeammateState = 'active' | 'off_owner' | 'off_td'

export interface Teammate {
  id: string
  username: string
  display_name: string
  email: string | null
  capabilities: Record<string, boolean>
  status: string
  state: TeammateState
  /** True when THIS signed-in owner has shared their own personal documents with this login (Team Powers step 7). */
  sharesMyDocs?: boolean
}

type ApiResult = { ok: boolean; error?: string; needsConfirmation?: boolean; data?: Record<string, unknown> }

async function api(path: string, method: string, body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || `Request failed (${res.status})`, needsConfirmation: data.needs_confirmation === true }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

const inputCls = 'flex h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-[11px] font-medium text-zinc-500">{label}</label>{children}</div>
}

/** The ticks, grouped in plain words. An option stays grey until the tick it hangs under is on. */
function TickPicker({ caps, onToggle }: { caps: Record<string, boolean>; onToggle: (key: string) => void }) {
  return (
    <div className="space-y-3" data-testid="tick-picker">
      {CAPABILITY_GROUPS.map(g => (
        <div key={g.key}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">{g.en}</p>
          <div className="space-y-0.5">
            {CAPABILITY_LABELS.filter(c => c.group === g.key).map(c => {
              const blocked = !!c.parent && !caps[c.parent]
              return (
                <label key={c.key} className={`flex items-start gap-2 text-xs p-1.5 rounded ${c.parent ? 'ml-6 ' : ''}${blocked ? 'text-zinc-300 cursor-not-allowed' : 'text-zinc-700 hover:bg-zinc-50 cursor-pointer'}`}>
                  <input type="checkbox" checked={!!caps[c.key]} disabled={blocked} onChange={() => onToggle(c.key)} className="mt-0.5" />
                  <span><span className={c.parent ? '' : 'font-medium'}>{c.en.label}</span><span className="block text-[10px] text-zinc-400">{c.en.hint}</span></span>
                </label>
              )
            })}
          </div>
        </div>
      ))}
      <p className="text-[11px] leading-relaxed text-zinc-500" data-testid="personal-docs-hint">
        <span className="font-medium text-zinc-600">Your personal documents</span> are not a tick here. Each owner shares their own, one person at a time, with the &ldquo;Share my personal documents&rdquo; button on that person&rsquo;s row.
      </p>
      <div className="text-[11px] leading-relaxed text-zinc-500 bg-zinc-50 border border-zinc-100 rounded-lg p-2.5" data-testid="never-box">
        <span className="font-medium text-zinc-600">No tick can give:</span> signing anything, generating documents, changing owners or members, managing the team, changing your login. These always stay with you and Tony Durante LLC.
      </div>
    </div>
  )
}

/** Step 2 of adding, or of giving more powers: the notice, the tick box and the owner's password. */
function ConfirmStep({
  lang, mode, memberName, companyName, caps, busy, error, onBack, onConfirm, confirmLabel, notice: readyNotice, checkboxLabel, draftVersion,
}: {
  lang: NoticeLang; mode: NoticeMode; memberName: string; companyName: string; caps: Record<string, boolean>
  busy: boolean; error: string; onBack: () => void; confirmLabel: string
  onConfirm: (proof: { notice_accepted: true; notice_version: string; notice_text: string; owner_password: string }) => void
  /** A notice already built by the caller (the personal-documents notice); otherwise the powers notice is built here. */
  notice?: Notice; checkboxLabel?: string; draftVersion?: string
}) {
  const notice = readyNotice ?? buildNotice({ lang, mode, memberName, companyName, caps })
  const [accepted, setAccepted] = useState(false)
  const [password, setPassword] = useState('')
  return (
    <div className="space-y-3" data-testid="confirm-step">
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700 space-y-2">
        <p className="font-semibold text-zinc-900">{notice.title}</p>
        <p>{notice.powersIntro}</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {notice.powers.length ? notice.powers.map(p => <li key={p}>{p}</li>) : <li>(no powers ticked)</li>}
        </ul>
        <p>{notice.responsibility}</p>
        <p>{notice.never}</p>
        <p className="text-[10px] text-zinc-400">Draft wording ({draftVersion ?? NOTICE_VERSION}).</p>
      </div>
      <label className="flex items-start gap-2 text-xs text-zinc-700">
        <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-0.5" data-testid="notice-accept" />
        <span>{checkboxLabel ?? noticeCheckboxLabel(lang)}</span>
      </label>
      <div className="max-w-xs">
        <Field label="Your password, to confirm it is you">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputCls} autoComplete="current-password" data-testid="owner-password" />
        </Field>
      </div>
      {error && <div className="p-2.5 rounded-lg bg-red-50 border border-red-100 text-xs text-red-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={onBack} disabled={busy} className="h-9 px-3 rounded-lg border text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">Back</button>
        <button
          onClick={() => onConfirm({ notice_accepted: true, notice_version: notice.version, notice_text: notice.text, owner_password: password })}
          disabled={busy || !accepted || !password}
          className="h-9 px-4 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
          data-testid="confirm-button"
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  )
}

export function TeamManager({ accountId, companyName, teammates, loginUrl, defaultLang = 'en', sharesUnavailable = false }: { accountId: string; companyName: string; teammates: Teammate[]; sharesUnavailable?: boolean; loginUrl: string; defaultLang?: NoticeLang }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Adding a person: step 1 = name + ticks, step 2 = the notice + password.
  const [adding, setAdding] = useState<null | 'details' | 'confirm'>(null)
  const [modalError, setModalError] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [caps, setCaps] = useState<Record<string, boolean>>({})

  // Editing powers: giving MORE power goes through the same notice + password step.
  const [editing, setEditing] = useState<null | { t: Teammate; draft: Record<string, boolean>; step: 'ticks' | 'confirm' }>(null)

  // Sharing the owner's OWN personal documents with one person (Team Powers step 7): the notice + password step, then a save.
  const [sharing, setSharing] = useState<null | Teammate>(null)

  // The message the owner copies and sends himself, shown ONCE after creating a team member or resetting a password. English only.
  const [handover, setHandover] = useState<{ kind: 'new' | 'reset'; displayName: string; username: string; password: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const resetAdd = () => { setUsername(''); setDisplayName(''); setCaps({}); setModalError('') }

  const submitAdd = async (proof: { notice_accepted: true; notice_version: string; notice_text: string; owner_password: string }) => {
    setModalError(''); setBusy(true)
    const r = await api('/api/portal/team', 'POST', {
      account_id: accountId, username: username || null, display_name: displayName, capabilities: caps, ...proof,
    })
    setBusy(false)
    if (!r.ok) { setModalError(r.error || 'Could not create team member'); return }
    const d = (r.data ?? {}) as { username?: string; password?: string }
    setAdding(null)
    setHandover({ kind: 'new', displayName, username: d.username ?? username, password: d.password ?? '' })
    setCopied(false)
    resetAdd(); router.refresh()
  }

  const saveEdit = async (proof?: { notice_accepted: true; notice_version: string; notice_text: string; owner_password: string }) => {
    if (!editing) return
    setModalError(''); setBusy(true)
    const r = await api(`/api/portal/team/${editing.t.id}`, 'PATCH', { account_id: accountId, capabilities: editing.draft, ...(proof ?? {}) })
    setBusy(false)
    if (r.needsConfirmation) { setEditing(e => (e ? { ...e, step: 'confirm' } : e)); return }
    if (!r.ok) { setModalError(r.error || 'Update failed'); return }
    setEditing(null); router.refresh()
  }

  const submitShare = async (proof: { notice_accepted: true; notice_version: string; notice_text: string; owner_password: string }) => {
    if (!sharing) return
    setModalError(''); setBusy(true)
    const r = await api(`/api/portal/team/${sharing.id}/personal-docs`, 'POST', { account_id: accountId, enabled: true, ...proof })
    setBusy(false)
    if (!r.ok) { setModalError(r.error || 'Could not share your documents'); return }
    setSharing(null); router.refresh()
  }

  const stopSharing = async (t: Teammate) => {
    if (!confirm(`Stop sharing your personal documents with ${t.display_name}? They stop seeing them at once.`)) return
    setBusy(true); setError('')
    const r = await api(`/api/portal/team/${t.id}/personal-docs`, 'POST', { account_id: accountId, enabled: false })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Could not stop sharing'); return }
    router.refresh()
  }

  const revoke = async (id: string, name: string) => {
    if (!confirm(`Remove ${name} for good? Their login is disabled at once and cannot be switched back on (you would add them again).`)) return
    setBusy(true); setError('')
    const r = await api(`/api/portal/team/${id}`, 'DELETE', { account_id: accountId })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Remove failed'); return }
    router.refresh()
  }

  const resetPw = async (id: string, name: string) => {
    if (!confirm(`Reset ${name}'s password? Their current password stops working at once and you get a new one to send them. Anyone's personal documents shared with this login stop being shared (each person shares again when they are ready).`)) return
    setBusy(true); setError('')
    const r = await api(`/api/portal/team/${id}/reset-password`, 'POST', { account_id: accountId })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Reset failed'); return }
    const d = (r.data ?? {}) as { username?: string; password?: string }
    setHandover({ kind: 'reset', displayName: name, username: d.username ?? '', password: d.password ?? '' })
    setCopied(false)
    router.refresh() // the "sharing your documents" marks on the list now read the new state (a reset ends the sharing)
  }

  const switchPerson = async (id: string, name: string, action: 'off' | 'on') => {
    const q = action === 'off'
      ? `Switch ${name} off? They cannot sign in until you switch them on again.`
      : `Switch ${name} back on? They can sign in again with the powers they had.`
    if (!confirm(q)) return
    setBusy(true); setError('')
    const r = await api(`/api/portal/team/${id}/switch`, 'POST', { account_id: accountId, action })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Could not switch the person'); return }
    router.refresh()
  }

  const handoverText = handover
    ? buildHandoverMessage({ lang: 'en', kind: handover.kind, displayName: handover.displayName, companyName, loginUrl, username: handover.username, password: handover.password })
    : ''

  return (
    <div className="max-w-3xl mx-auto px-4 lg:px-8 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Team</h1>
          <p className="text-sm text-zinc-500">{companyName} — invite employees to access this company&rsquo;s portal.</p>
        </div>
        <button onClick={() => { resetAdd(); setAdding('details') }} className="h-10 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
          + Add team member
        </button>
      </div>

      {error && <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-700">{error}</div>}

      <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs leading-relaxed text-blue-900 space-y-1" data-testid="team-notice">
        <p><span className="font-semibold">Chat alerts.</span> Team members have no email in the portal, for their privacy and security. They receive chat alerts <span className="font-semibold">only through the app on their phone</span>: ask each colleague to install the app and tap &ldquo;Enable notifications&rdquo; (the message you copy after adding them explains how). Without it, only you and the other members of the company get the email alert.</p>
        <p><span className="font-semibold">Owners and members of the company</span> must not be added here. They get their own full login with the same access as you: contact support and we will send it.</p>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl border divide-y">
        {teammates.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500 text-center">No team members yet.</p>
        ) : teammates.map(t => (
          <div key={t.id} className="p-4 flex items-center justify-between gap-3" data-testid="team-row">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900 truncate">
                {t.display_name} <span className="text-zinc-400 font-normal">@{t.username}</span>{' '}
                {t.state === 'active' && <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Active</span>}
                {t.state === 'off_owner' && <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">Switched off by you</span>}
                {t.state === 'off_td' && <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700">Switched off by Tony Durante LLC</span>}
              </p>
              <p className="text-xs text-zinc-500 truncate">{describeCapabilities(t.capabilities, 'en').join(', ') || 'no access granted'}</p>
              {t.state === 'active' && t.capabilities.documents && (
                <p className="text-[11px] mt-0.5" data-testid="personal-docs-row">
                  {sharesUnavailable ? (
                    <span className="text-amber-700" data-testid="personal-docs-unavailable">Your personal documents: we could not check the sharing right now. Please refresh the page.</span>
                  ) : t.sharesMyDocs ? (
                    <><span className="text-amber-700 font-medium">Your personal documents are shared with this person.</span>{' '}
                      <button onClick={() => stopSharing(t)} disabled={busy} className="underline text-zinc-500 hover:text-zinc-800 disabled:opacity-50" data-testid="personal-docs-stop">Stop sharing</button></>
                  ) : (
                    <><span className="text-zinc-400">Your personal documents: not shared.</span>{' '}
                      <button onClick={() => { setModalError(''); setSharing(t) }} disabled={busy} className="underline text-blue-600 hover:text-blue-800 disabled:opacity-50" data-testid="personal-docs-share">Share my personal documents</button></>
                  )}
                </p>
              )}
              {t.state === 'off_td' && <p className="text-[11px] text-zinc-400 mt-0.5">Please contact us to switch this person back on.</p>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {t.state === 'active' && (<>
                <button onClick={() => { setModalError(''); setEditing({ t, draft: { ...(t.capabilities || {}) }, step: 'ticks' }) }} className="text-xs px-2 py-1 rounded border hover:bg-zinc-50">Edit powers</button>
                <button onClick={() => resetPw(t.id, t.display_name)} disabled={busy} className="text-xs px-2 py-1 rounded border hover:bg-zinc-50 disabled:opacity-50">Reset password</button>
                <button onClick={() => switchPerson(t.id, t.display_name, 'off')} disabled={busy} className="text-xs px-2 py-1 rounded border border-dashed hover:bg-zinc-50 disabled:opacity-50">Switch off</button>
                <button onClick={() => revoke(t.id, t.display_name)} disabled={busy} className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">Remove</button>
              </>)}
              {t.state === 'off_owner' && (<>
                <button onClick={() => switchPerson(t.id, t.display_name, 'on')} disabled={busy} className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">Switch on</button>
                <button onClick={() => revoke(t.id, t.display_name)} disabled={busy} className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">Remove</button>
              </>)}
            </div>
          </div>
        ))}
      </div>

      {/* Add: step 1 (name + ticks) and step 2 (notice + password) */}
      {adding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setAdding(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-zinc-900">Add team member — {companyName} <span className="text-zinc-400 font-normal">· step {adding === 'details' ? 1 : 2} of 2</span></h3>

            {adding === 'details' ? (<>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name"><input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputCls} placeholder="Mario Rossi" /></Field>
                <Field label="Username (optional)"><input value={username} onChange={e => setUsername(e.target.value)} className={inputCls} placeholder="suggested from the name" /></Field>
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                The name is shown on this person&apos;s chat messages so your team can see who&apos;s writing.{' '}
                <span className="font-medium text-zinc-600">No email and no password to type:</span> we create the login and a temporary password, and show you a message to copy and send. The colleague signs in with the username and chooses their own password the first time.
              </p>
              <div>
                <p className="text-xs font-medium text-zinc-700 mb-2">What can this person do?</p>
                <TickPicker caps={caps} onToggle={key => setCaps(c => toggleWithChildren(c, key))} />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setAdding(null)} className="h-9 px-3 rounded-lg border text-sm text-zinc-700 hover:bg-zinc-50">Cancel</button>
                <button onClick={() => setAdding('confirm')} disabled={displayName.trim().length < 2} className="h-9 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50" data-testid="add-next">Next</button>
              </div>
            </>) : (
              <ConfirmStep
                lang={defaultLang} mode="add" memberName={displayName} companyName={companyName} caps={caps}
                busy={busy} error={modalError} onBack={() => { setModalError(''); setAdding('details') }}
                onConfirm={submitAdd} confirmLabel={`Add ${displayName.trim().split(/\s+/)[0] || 'person'}`}
              />
            )}
          </div>
        </div>
      )}

      {/* Edit powers */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setEditing(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-zinc-900">Powers of {editing.t.display_name}</h3>
            {editing.step === 'ticks' ? (<>
              <TickPicker caps={editing.draft} onToggle={key => setEditing(e => (e ? { ...e, draft: toggleWithChildren(e.draft, key) } : e))} />
              {modalError && <div className="p-2.5 rounded-lg bg-red-50 border border-red-100 text-xs text-red-700">{modalError}</div>}
              <p className="text-[11px] text-zinc-500">Taking powers away saves at once. Adding a power asks you to read the notice and enter your password.</p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(null)} disabled={busy} className="h-9 px-3 rounded-lg border text-sm text-zinc-700 hover:bg-zinc-50">Cancel</button>
                <button
                  onClick={() => (addsPower(editing.t.capabilities || {}, editing.draft) ? setEditing(e => (e ? { ...e, step: 'confirm' } : e)) : saveEdit())}
                  disabled={busy} className="h-9 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50" data-testid="edit-save"
                >
                  {addsPower(editing.t.capabilities || {}, editing.draft) ? 'Next' : 'Save'}
                </button>
              </div>
            </>) : (
              <ConfirmStep
                lang={defaultLang} mode="more" memberName={editing.t.display_name} companyName={companyName} caps={editing.draft}
                busy={busy} error={modalError} onBack={() => { setModalError(''); setEditing(e => (e ? { ...e, step: 'ticks' } : e)) }}
                onConfirm={saveEdit} confirmLabel="Give these powers"
              />
            )}
          </div>
        </div>
      )}

      {/* Share my personal documents: the notice + password step (Team Powers step 7) */}
      {sharing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setSharing(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-zinc-900">Share my personal documents with {sharing.display_name}</h3>
            <ConfirmStep
              lang={defaultLang} mode="more" memberName={sharing.display_name} companyName={companyName} caps={sharing.capabilities}
              notice={buildPersonalDocsNotice({ lang: defaultLang, memberName: sharing.display_name, companyName })}
              checkboxLabel={personalDocsCheckboxLabel(defaultLang)} draftVersion={PERSONAL_DOCS_NOTICE_VERSION}
              busy={busy} error={modalError} onBack={() => { setModalError(''); setSharing(null) }}
              onConfirm={submitShare} confirmLabel="Share my documents"
            />
          </div>
        </div>
      )}

      {/* Handover: shown ONCE after creating a team member or resetting a password. The owner copies it and sends it himself. English only. */}
      {handover && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="team-handover">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-zinc-900">
              {handover.kind === 'new' ? `${handover.displayName} is added` : `New password for ${handover.displayName}`}
            </h3>
            <p className="text-xs text-zinc-600">
              Copy this message and send it to {handover.displayName.split(' ')[0] || 'them'} (WhatsApp, text or email).
              <span className="font-semibold"> The password is shown only now</span> — if you lose it, use Reset password to make a new one.
            </p>
            <textarea readOnly rows={13} value={handoverText} className="w-full text-xs font-mono rounded-lg border border-zinc-200 bg-zinc-50 p-3" onFocus={e => e.currentTarget.select()} />
            <div className="flex justify-end gap-2">
              <button
                onClick={async () => { try { await navigator.clipboard.writeText(handoverText); setCopied(true) } catch { setCopied(false) } }}
                className="h-9 px-3 rounded-lg border text-sm text-zinc-700 hover:bg-zinc-50"
              >
                {copied ? 'Copied ✓' : 'Copy message'}
              </button>
              <button onClick={() => setHandover(null)} className="h-9 px-4 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
