'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { buildHandoverMessage, type HandoverLang } from '@/lib/portal/team/handover'

// Owner-grantable capability toggles (labels for the invite/edit UI).
// Keys must match lib/portal/team/capabilities.ts.
const CAPABILITIES: { key: string; label: string; hint?: string; parent?: string }[] = [
  { key: 'documents', label: 'Documents', hint: 'View documents incl. legal docs (cannot sign)' },
  { key: 'invoices_billing', label: 'Invoices & Billing' },
  // Options that only make sense once Invoices & Billing is ticked (dev job e5d5400d, Antonio 2026-10-21).
  { key: 'payment_links', label: 'Can change payment links', hint: 'Add, remove or change the links customers use to pay. Off = they can only see them.', parent: 'invoices_billing' },
  { key: 'invoice_history', label: 'Can see invoices & expenses from before they joined', hint: 'Off = they only see what is saved from the day you add them.', parent: 'invoices_billing' },
  { key: 'chat', label: 'Chat' },
  { key: 'company_services', label: 'Company & Services' },
  { key: 'bank_applications', label: 'Bank Applications' },
  { key: 'sales_customers', label: 'Sales customers' },
  { key: 'company_data_form', label: 'Company data form' },
  { key: 'announcements', label: 'Announcements' },
]

/** Ticking/unticking one box; unticking a main box also clears the options that hang under it. */
export function toggleWithChildren(c: Record<string, boolean>, key: string): Record<string, boolean> {
  const next = { ...c, [key]: !c[key] }
  if (!next[key]) for (const o of CAPABILITIES) if (o.parent === key) next[o.key] = false
  return next
}

export interface Teammate {
  id: string
  username: string
  display_name: string
  email: string | null
  capabilities: Record<string, boolean>
  status: string
}

async function api(path: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  try {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || `Request failed (${res.status})` }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

export function TeamManager({ accountId, companyName, teammates, loginUrl, defaultLang = 'en' }: { accountId: string; companyName: string; teammates: Teammate[]; loginUrl: string; defaultLang?: HandoverLang }) {
  const router = useRouter()
  const [showInvite, setShowInvite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // invite form: no email and no password (the system makes the password; the colleague signs in with the username)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [caps, setCaps] = useState<Record<string, boolean>>({})
  const [disclaimer, setDisclaimer] = useState(false)

  // The message the owner copies and sends himself, shown ONCE after creating a team member or resetting a password.
  const [handover, setHandover] = useState<{ kind: 'new' | 'reset'; displayName: string; username: string; password: string } | null>(null)
  const [handoverLang, setHandoverLang] = useState<HandoverLang>(defaultLang)
  const [copied, setCopied] = useState(false)

  const resetForm = () => {
    setUsername(''); setDisplayName(''); setCaps({}); setDisclaimer(false); setError('')
  }

  const submitInvite = async () => {
    setError(''); setBusy(true)
    const r = await api('/api/portal/team', 'POST', {
      account_id: accountId, username: username || null, display_name: displayName,
      capabilities: caps, disclaimer_accepted: disclaimer,
    })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Could not create team member'); return }
    const d = (r.data ?? {}) as { username?: string; password?: string }
    setShowInvite(false)
    setHandover({ kind: 'new', displayName, username: d.username ?? username, password: d.password ?? '' })
    setCopied(false)
    resetForm(); router.refresh()
  }

  const toggleCap = (key: string) => setCaps(c => toggleWithChildren(c, key))

  const saveCaps = async (id: string, next: Record<string, boolean>) => {
    setBusy(true)
    const r = await api(`/api/portal/team/${id}`, 'PATCH', { account_id: accountId, capabilities: next })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Update failed'); return }
    router.refresh()
  }

  const revoke = async (id: string, name: string) => {
    if (!confirm(`Remove ${name}'s access? Their login will be disabled immediately.`)) return
    setBusy(true)
    const r = await api(`/api/portal/team/${id}`, 'DELETE', { account_id: accountId })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Remove failed'); return }
    router.refresh()
  }

  const resetPw = async (id: string, name: string) => {
    if (!confirm(`Reset ${name}'s password? Their current password stops working at once and you get a new one to send them.`)) return
    setBusy(true)
    const r = await api(`/api/portal/team/${id}/reset-password`, 'POST', { account_id: accountId })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Reset failed'); return }
    const d = (r.data ?? {}) as { username?: string; password?: string }
    setHandover({ kind: 'reset', displayName: name, username: d.username ?? '', password: d.password ?? '' })
    setCopied(false)
  }

  const active = teammates.filter(t => t.status === 'active')

  return (
    <div className="max-w-3xl mx-auto px-4 lg:px-8 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Team</h1>
          <p className="text-sm text-zinc-500">{companyName} — invite employees to access this company&rsquo;s portal.</p>
        </div>
        <button onClick={() => { resetForm(); setShowInvite(true) }} className="h-10 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
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
        {active.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500 text-center">No team members yet.</p>
        ) : active.map(t => (
          <TeammateRow key={t.id} t={t} busy={busy} onSaveCaps={saveCaps} onRevoke={revoke} onResetPw={resetPw} />
        ))}
      </div>

      {/* Invite modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setShowInvite(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-zinc-900">Add team member — {companyName}</h3>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Display name"><input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputCls} placeholder="Mario Rossi" /></Field>
              <Field label="Username (optional)"><input value={username} onChange={e => setUsername(e.target.value)} className={inputCls} placeholder="suggested from the name" /></Field>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500">
              <span className="font-medium text-zinc-600">Display name</span> is shown on this teammate&apos;s chat messages so your team can see who&apos;s writing.{' '}
              <span className="font-medium text-zinc-600">No email and no password to type:</span> we create the login and a temporary password, and show you a message to copy and send. The colleague signs in with the username and chooses their own password the first time.
            </p>

            <div>
              <p className="text-xs font-medium text-zinc-700 mb-1.5">What can this teammate access?</p>
              <div className="grid grid-cols-2 gap-1.5">
                {CAPABILITIES.map(c => (
                  <label key={c.key} className={`flex items-start gap-2 text-xs p-1.5 rounded ${c.parent ? 'col-span-2 ml-6 ' : ''}${c.parent && !caps[c.parent] ? 'text-zinc-300 cursor-not-allowed' : 'text-zinc-700 hover:bg-zinc-50 cursor-pointer'}`}>
                    <input type="checkbox" checked={!!caps[c.key]} disabled={!!c.parent && !caps[c.parent]} onChange={() => toggleCap(c.key)} className="mt-0.5" />
                    <span><span className="font-medium">{c.label}</span>{c.hint && <span className="block text-[10px] text-zinc-400">{c.hint}</span>}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs text-zinc-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <input type="checkbox" checked={disclaimer} onChange={e => setDisclaimer(e.target.checked)} className="mt-0.5" />
              <span>We are not responsible for what your teammate can or cannot do in the system. <span className="font-medium">You are responsible for everything that happens in the system and for who has access.</span></span>
            </label>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowInvite(false)} disabled={busy} className="h-9 px-3 rounded-lg border text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">Cancel</button>
              <button onClick={submitInvite} disabled={busy || !disclaimer} className="h-9 px-4 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                {busy ? 'Creating…' : 'Create team member'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Handover: shown ONCE after creating a team member or resetting a password. The owner copies it and sends it himself. */}
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
            <div className="flex gap-1.5">
              {(['en', 'it'] as const).map(l => (
                <button key={l} onClick={() => { setHandoverLang(l); setCopied(false) }}
                  className={`text-xs px-2.5 py-1 rounded border ${handoverLang === l ? 'bg-zinc-900 text-white border-zinc-900' : 'hover:bg-zinc-50'}`}>
                  {l === 'en' ? 'English' : 'Italiano'}
                </button>
              ))}
            </div>
            <textarea
              readOnly
              rows={13}
              value={buildHandoverMessage({ lang: handoverLang, kind: handover.kind, displayName: handover.displayName, companyName, loginUrl, username: handover.username, password: handover.password })}
              className="w-full text-xs font-mono rounded-lg border border-zinc-200 bg-zinc-50 p-3"
              onFocus={e => e.currentTarget.select()}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={async () => {
                  const text = buildHandoverMessage({ lang: handoverLang, kind: handover.kind, displayName: handover.displayName, companyName, loginUrl, username: handover.username, password: handover.password })
                  try { await navigator.clipboard.writeText(text); setCopied(true) } catch { setCopied(false) }
                }}
                className="h-9 px-3 rounded-lg border text-sm text-zinc-700 hover:bg-zinc-50"
              >
                {copied ? 'Copied ✓' : 'Copy message'}
              </button>
              <button onClick={() => setHandover(null)} className="h-9 px-4 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputCls = 'flex h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-[11px] font-medium text-zinc-500">{label}</label>{children}</div>
}

function TeammateRow({ t, busy, onSaveCaps, onRevoke, onResetPw }: {
  t: Teammate; busy: boolean
  onSaveCaps: (id: string, next: Record<string, boolean>) => void
  onRevoke: (id: string, name: string) => void
  onResetPw: (id: string, name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, boolean>>(t.capabilities || {})
  const granted = CAPABILITIES.filter(c => t.capabilities?.[c.key]).map(c => c.label)

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900 truncate">{t.display_name} <span className="text-zinc-400 font-normal">@{t.username}</span></p>
          <p className="text-xs text-zinc-500 truncate">{granted.length ? granted.join(', ') : 'no access granted'}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => { setDraft(t.capabilities || {}); setEditing(e => !e) }} className="text-xs px-2 py-1 rounded border hover:bg-zinc-50">Edit</button>
          <button onClick={() => onResetPw(t.id, t.display_name)} disabled={busy} className="text-xs px-2 py-1 rounded border hover:bg-zinc-50 disabled:opacity-50">Reset password</button>
          <button onClick={() => onRevoke(t.id, t.display_name)} disabled={busy} className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">Remove</button>
        </div>
      </div>
      {editing && (
        <div className="border-t pt-2">
          <div className="grid grid-cols-2 gap-1.5">
            {CAPABILITIES.map(c => (
              <label key={c.key} className={`flex items-center gap-2 text-xs p-1 ${c.parent ? 'col-span-2 ml-6 ' : ''}${c.parent && !draft[c.parent] ? 'text-zinc-300 cursor-not-allowed' : 'text-zinc-700 cursor-pointer'}`}>
                <input type="checkbox" checked={!!draft[c.key]} disabled={!!c.parent && !draft[c.parent]} onChange={() => setDraft(d => toggleWithChildren(d, c.key))} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={() => setEditing(false)} className="text-xs px-2 py-1 rounded border hover:bg-zinc-50">Cancel</button>
            <button onClick={() => { onSaveCaps(t.id, draft); setEditing(false) }} disabled={busy} className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
          </div>
        </div>
      )}
    </div>
  )
}
