'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Owner-grantable capability toggles (labels for the invite/edit UI).
// Keys must match lib/portal/team/capabilities.ts.
const CAPABILITIES: { key: string; label: string; hint?: string }[] = [
  { key: 'documents', label: 'Documents', hint: 'View documents incl. legal docs (cannot sign)' },
  { key: 'invoices_billing', label: 'Invoices & Billing' },
  { key: 'chat', label: 'Chat' },
  { key: 'company_services', label: 'Company & Services' },
  { key: 'bank_applications', label: 'Bank Applications' },
  { key: 'sales_customers', label: 'Sales customers' },
  { key: 'company_data_form', label: 'Company data form' },
  { key: 'announcements', label: 'Announcements' },
]

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

export function TeamManager({ accountId, companyName, teammates }: { accountId: string; companyName: string; teammates: Teammate[] }) {
  const router = useRouter()
  const [showInvite, setShowInvite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // invite form
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [caps, setCaps] = useState<Record<string, boolean>>({})
  const [disclaimer, setDisclaimer] = useState(false)

  const resetForm = () => {
    setUsername(''); setDisplayName(''); setPassword(''); setEmail(''); setCaps({}); setDisclaimer(false); setError('')
  }

  const submitInvite = async () => {
    setError(''); setBusy(true)
    const r = await api('/api/portal/team', 'POST', {
      account_id: accountId, username, display_name: displayName, password, email: email || null,
      capabilities: caps, disclaimer_accepted: disclaimer,
    })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Could not create team member'); return }
    setShowInvite(false); resetForm(); router.refresh()
  }

  const toggleCap = (key: string) => setCaps(c => ({ ...c, [key]: !c[key] }))

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
    const pw = prompt(`New password for ${name} (min 8 characters):`)
    if (!pw) return
    setBusy(true)
    const r = await api(`/api/portal/team/${id}/reset-password`, 'POST', { account_id: accountId, password: pw })
    setBusy(false)
    if (!r.ok) { setError(r.error || 'Reset failed'); return }
    alert('Password updated. Share the new password with your teammate.')
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
              <Field label="Username (login)"><input value={username} onChange={e => setUsername(e.target.value)} className={inputCls} placeholder="e.g. mario.rossi" /></Field>
              <Field label="Display name"><input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputCls} placeholder="Mario Rossi" /></Field>
              <Field label="Password"><input value={password} onChange={e => setPassword(e.target.value)} className={inputCls} placeholder="min 8 characters" /></Field>
              <Field label="Email (optional)"><input value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="for notifications + reset" /></Field>
            </div>

            <div>
              <p className="text-xs font-medium text-zinc-700 mb-1.5">What can this teammate access?</p>
              <div className="grid grid-cols-2 gap-1.5">
                {CAPABILITIES.map(c => (
                  <label key={c.key} className="flex items-start gap-2 text-xs text-zinc-700 p-1.5 rounded hover:bg-zinc-50 cursor-pointer">
                    <input type="checkbox" checked={!!caps[c.key]} onChange={() => toggleCap(c.key)} className="mt-0.5" />
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
          <p className="text-xs text-zinc-500 truncate">{t.email || 'no email — in-portal only'} · {granted.length ? granted.join(', ') : 'no access granted'}</p>
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
              <label key={c.key} className="flex items-center gap-2 text-xs text-zinc-700 p-1 cursor-pointer">
                <input type="checkbox" checked={!!draft[c.key]} onChange={() => setDraft(d => ({ ...d, [c.key]: !d[c.key] }))} />
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
