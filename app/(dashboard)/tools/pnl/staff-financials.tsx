'use client'

import { useState, useEffect, useCallback } from 'react'
import { Building2, Loader2, Plus, Copy, Trash2, ArrowLeft, Save, X } from 'lucide-react'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { TaxFinancialsReview } from '@/components/portal/tax-financials-review'

interface WorkspaceRow {
  id: string
  label: string | null
  company_name: string | null
  tax_year: number
  entity_type: string
  linked_account_id: string | null
  updated_at: string
}

interface MemberDraft {
  member_type: 'individual' | 'company'
  display_name: string
  ownership_pct: string
}

const inputCls = 'w-full h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

/**
 * Standalone P&L tool (staff). A workspace is an ISOLATED sandbox: run a P&L /
 * Balance Sheet from scratch OR forked from a client, tweak freely, and only
 * push to a real client via an explicit, audited "Save to client". Nothing here
 * touches a client's real books until that button is pressed.
 */
export function StaffFinancials({ defaultYear }: { defaultYear: number }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<{ id: string; name: string; taxYear: number; linkedAccountId: string | null } | null>(null)
  const [mode, setMode] = useState<'blank' | 'fork' | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/tools/pnl')
      const d = await res.json().catch(() => ({}))
      setWorkspaces(res.ok ? (d.workspaces ?? []) : [])
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  if (open) {
    return <OpenWorkspace ws={open} onBack={() => { setOpen(null); void load() }} />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setMode(mode === 'blank' ? null : 'blank')}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium ${mode === 'blank' ? 'bg-blue-600 text-white' : 'border text-zinc-700 hover:border-blue-300'}`}>
          <Plus className="h-4 w-4" /> New blank workspace
        </button>
        <button type="button" onClick={() => setMode(mode === 'fork' ? null : 'fork')}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium ${mode === 'fork' ? 'bg-blue-600 text-white' : 'border text-zinc-700 hover:border-blue-300'}`}>
          <Copy className="h-4 w-4" /> Fork a client
        </button>
      </div>

      {mode === 'blank' && <BlankForm defaultYear={defaultYear} onCreated={ws => { setMode(null); setOpen({ ...ws, linkedAccountId: null }) }} onDone={load} />}
      {mode === 'fork' && <ForkForm defaultYear={defaultYear} onDone={() => { setMode(null); void load() }} />}

      <div className="rounded-xl border bg-white">
        <div className="border-b px-4 py-3 text-sm font-medium text-zinc-700">Your workspaces</div>
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : workspaces.length === 0 ? (
          <div className="px-4 py-6 text-sm text-zinc-500">No workspaces yet — create a blank one or fork a client above.</div>
        ) : (
          <ul className="divide-y">
            {workspaces.map(w => (
              <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50">
                <button type="button" onClick={() => setOpen({ id: w.id, name: w.label || w.company_name || 'Workspace', taxYear: w.tax_year, linkedAccountId: w.linked_account_id })}
                  className="flex items-center gap-2 min-w-0 text-left">
                  <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
                  <span className="text-sm font-medium text-zinc-800 truncate">{w.label || w.company_name || 'Workspace'}</span>
                  <span className="text-xs text-zinc-500 shrink-0">· {w.tax_year}{w.linked_account_id ? ' · forked' : ''}</span>
                </button>
                <DeleteWorkspace id={w.id} onDone={load} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function BlankForm({ defaultYear, onCreated, onDone }: { defaultYear: number; onCreated: (ws: { id: string; name: string; taxYear: number }) => void; onDone: () => void }) {
  const [label, setLabel] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [ein, setEin] = useState('')
  const [year, setYear] = useState(String(defaultYear))
  const [members, setMembers] = useState<MemberDraft[]>([{ member_type: 'individual', display_name: '', ownership_pct: '' }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pctTotal = members.reduce((s, m) => s + (Number(m.ownership_pct) || 0), 0)
  const setMember = (i: number, patch: Partial<MemberDraft>) => setMembers(ms => ms.map((m, j) => j === i ? { ...m, ...patch } : m))

  async function create() {
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/tools/pnl', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'blank', label: label.trim() || undefined, tax_year: Number(year),
          company_name: companyName.trim() || undefined, ein: ein.trim() || undefined,
          members: members.filter(m => m.display_name.trim()).map(m => ({ member_type: m.member_type, display_name: m.display_name.trim(), ownership_pct: m.ownership_pct === '' ? null : Number(m.ownership_pct) })),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create the workspace.')
      onCreated({ id: d.id, name: label.trim() || companyName.trim() || 'Workspace', taxYear: Number(year) })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the workspace.')
    } finally {
      setBusy(false); onDone()
    }
  }

  return (
    <div className="rounded-xl border bg-white p-5 space-y-4 max-w-2xl">
      <h3 className="text-sm font-semibold text-zinc-800">New blank workspace (MMLLC)</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">Company name</label>
          <input className={inputCls} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Exact legal name, e.g. B&P International LLC" />
          <p className="mt-1 text-[11px] text-zinc-500">Use the company&apos;s EXACT legal name as it appears on the bank statements — it&apos;s how transfers between the company&apos;s own accounts are recognized (not counted as revenue/expenses).</p>
        </div>
        <div><label className="block text-xs font-medium text-zinc-600 mb-1">EIN (optional)</label><input className={inputCls} value={ein} onChange={e => setEin(e.target.value)} /></div>
        <div><label className="block text-xs font-medium text-zinc-600 mb-1">Tax year</label><input type="number" min={2000} max={2100} className={inputCls} value={year} onChange={e => setYear(e.target.value)} /></div>
        <div><label className="block text-xs font-medium text-zinc-600 mb-1">Label (optional)</label><input className={inputCls} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. scenario A" /></div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-zinc-600">Members</label>
          <span className={`text-xs ${Math.abs(pctTotal - 100) < 0.5 ? 'text-green-700' : 'text-amber-600'}`}>Total: {pctTotal}%</span>
        </div>
        <div className="space-y-2">
          {members.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <select className="h-9 rounded-md border px-2 text-sm" value={m.member_type} onChange={e => setMember(i, { member_type: e.target.value as 'individual' | 'company' })}>
                <option value="individual">Person</option>
                <option value="company">Company</option>
              </select>
              <input className="flex-1 h-9 rounded-md border px-2 text-sm" placeholder={m.member_type === 'company' ? 'Company legal name' : 'Full name'} value={m.display_name} onChange={e => setMember(i, { display_name: e.target.value })} />
              <input className="w-20 h-9 rounded-md border px-2 text-sm" type="number" placeholder="%" value={m.ownership_pct} onChange={e => setMember(i, { ownership_pct: e.target.value })} />
              {members.length > 1 && <button type="button" onClick={() => setMembers(ms => ms.filter((_, j) => j !== i))} className="p-1 text-zinc-400 hover:text-red-600"><X className="h-4 w-4" /></button>}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setMembers(ms => [...ms, { member_type: 'individual', display_name: '', ownership_pct: '' }])} className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700">+ Add member</button>
      </div>

      {err && <p className="text-xs text-red-700">{err}</p>}
      <button type="button" disabled={busy} onClick={() => void create()} className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create workspace
      </button>
    </div>
  )
}

function ForkForm({ defaultYear, onDone }: { defaultYear: number; onDone: () => void }) {
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [year, setYear] = useState(String(defaultYear))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function create() {
    if (!accountId) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/tools/pnl', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'fork', source_account_id: accountId, tax_year: Number(year) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not fork this client.')
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not fork this client.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border bg-white p-5 space-y-4 max-w-2xl">
      <h3 className="text-sm font-semibold text-zinc-800">Fork a client into a private workspace</h3>
      <p className="text-xs text-zinc-500">Copies the client&apos;s transactions, members, and prior return into an isolated workspace. The real client is never changed.</p>
      <div><label className="block text-xs font-medium text-zinc-600 mb-1">Client account (MMLLC)</label>
        <AccountCombobox value={accountId} displayValue={accountName} onChange={(id, name) => { setAccountId(id); setAccountName(name) }} />
      </div>
      <div className="w-40"><label className="block text-xs font-medium text-zinc-600 mb-1">Tax year</label><input type="number" min={2000} max={2100} className={inputCls} value={year} onChange={e => setYear(e.target.value)} /></div>
      {err && <p className="text-xs text-red-700">{err}</p>}
      <button type="button" disabled={busy || !accountId} onClick={() => void create()} className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />} Fork into workspace
      </button>
    </div>
  )
}

function DeleteWorkspace({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  async function del() {
    setBusy(true)
    try { await fetch(`/api/tools/pnl/${id}`, { method: 'DELETE' }) } finally { setBusy(false); onDone() }
  }
  if (!confirm) return <button type="button" onClick={() => setConfirm(true)} className="p-1 text-zinc-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
  return (
    <span className="flex items-center gap-1 text-xs">
      <button type="button" disabled={busy} onClick={() => void del()} className="rounded bg-red-600 px-2 py-0.5 text-white">Delete</button>
      <button type="button" onClick={() => setConfirm(false)} className="text-zinc-500">Cancel</button>
    </span>
  )
}

function OpenWorkspace({ ws, onBack }: { ws: { id: string; name: string; taxYear: number; linkedAccountId: string | null }; onBack: () => void }) {
  const [saving, setSaving] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-white px-4 py-3">
        <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700"><ArrowLeft className="h-4 w-4" /> Workspaces</button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-zinc-800 truncate">{ws.name}</span>
          <span className="text-xs text-zinc-500">· {ws.taxYear}</span>
        </div>
        <button type="button" onClick={() => setSaving(true)} className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700">
          <Save className="h-3.5 w-3.5" /> Save to client
        </button>
      </div>
      {saving && <SaveToClient workspaceId={ws.id} defaultAccountId={ws.linkedAccountId} onClose={() => setSaving(false)} />}
      <TaxFinancialsReview accountId="" taxYear={ws.taxYear} locale="en" mode="staff" apiBase={`/api/tools/pnl/${ws.id}`} />
    </div>
  )
}

function SaveToClient({ workspaceId, defaultAccountId, onClose }: { workspaceId: string; defaultAccountId: string | null; onClose: () => void }) {
  const [accountId, setAccountId] = useState<string | undefined>(defaultAccountId ?? undefined)
  const [accountName, setAccountName] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [needMode, setNeedMode] = useState(false)

  async function save(mode?: 'merge' | 'replace') {
    if (!accountId) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch(`/api/tools/pnl/${workspaceId}/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_account_id: accountId, mode }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 409) { setNeedMode(true); setMsg({ ok: false, text: d.error || 'This client already has data for this year — choose Merge or Replace.' }); return }
      if (!res.ok) throw new Error(d.error || 'Save failed.')
      setNeedMode(false)
      setMsg({ ok: true, text: `Saved to client — ${d.inserted} row(s) added${d.deleted ? `, ${d.deleted} replaced` : ''}${d.backupPath ? ' (backup taken)' : ''}.` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Save failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/40 p-5 space-y-3 max-w-2xl">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-800">Save this workspace to a real client</h3>
        <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-700"><X className="h-4 w-4" /></button>
      </div>
      <p className="text-xs text-zinc-500">Writes this workspace&apos;s transactions into the client&apos;s real books. This is the only action that changes real client data.</p>
      <AccountCombobox value={accountId} displayValue={accountName} onChange={(id, name) => { setAccountId(id); setAccountName(name); setNeedMode(false); setMsg(null) }} />
      {msg && <p className={`text-xs ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
      {needMode ? (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void save('merge')} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">Merge (add only)</button>
          <button type="button" disabled={busy} onClick={() => void save('replace')} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Replace (overwrite)</button>
        </div>
      ) : (
        <button type="button" disabled={busy || !accountId} onClick={() => void save()} className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save to client
        </button>
      )}
    </div>
  )
}
