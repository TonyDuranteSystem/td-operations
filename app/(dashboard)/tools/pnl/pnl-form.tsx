'use client'

import { useState } from 'react'
import { Building2, Globe, Upload, Plus, Trash2, CheckCircle2, Loader2 } from 'lucide-react'
import { AccountCombobox } from '@/components/shared/account-combobox'

type Mode = 'client' | 'external'
interface Member { name: string; ownership_pct: string }

/** Parse a Content-Disposition filename, with a fallback. */
function filenameFromResponse(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') || ''
  const m = cd.match(/filename="?([^"]+)"?/)
  return m?.[1] || fallback
}

async function downloadXlsx(res: Response, fallbackName: string) {
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filenameFromResponse(res, fallbackName)
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function PnlForm({ defaultYear }: { defaultYear: number }) {
  const [mode, setMode] = useState<Mode>('client')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // Existing-client state
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [clientYear, setClientYear] = useState(String(defaultYear))
  const [saveToDrive, setSaveToDrive] = useState(true)

  // External state
  const [companyName, setCompanyName] = useState('')
  const [extYear, setExtYear] = useState(String(defaultYear))
  const [members, setMembers] = useState<Member[]>([{ name: '', ownership_pct: '100' }])
  const [files, setFiles] = useState<File[]>([])
  const [priorFiles, setPriorFiles] = useState<File[]>([])

  const ownershipTotal = members.reduce((s, m) => s + (parseFloat(m.ownership_pct) || 0), 0)

  const resetFeedback = () => { setError(null); setDone(null) }

  async function submitClient(e: React.FormEvent) {
    e.preventDefault()
    resetFeedback()
    if (!accountId) { setError('Pick a client account first.'); return }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set('account_id', accountId)
      fd.set('tax_year', clientYear)
      fd.set('save_to_drive', String(saveToDrive))
      const res = await fetch('/api/tools/pnl/generate', { method: 'POST', body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not generate the P&L. Please try again.')
      }
      await downloadXlsx(res, `${accountName || 'client'} - PnL ${clientYear}.xlsx`)
      const link = res.headers.get('X-Drive-Link')
      setDone(link ? `Downloaded. Also saved to Drive: ${link}` : 'Downloaded.')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not generate the P&L.')
    } finally {
      setBusy(false)
    }
  }

  async function submitExternal(e: React.FormEvent) {
    e.preventDefault()
    resetFeedback()
    if (!companyName.trim()) { setError('Enter the company name.'); return }
    if (files.length === 0) { setError('Upload at least one CSV bank statement for the year.'); return }
    if (Math.abs(ownershipTotal - 100) > 0.5) {
      setError(`Ownership must total 100% (currently ${ownershipTotal.toFixed(1)}%).`); return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set('company_name', companyName.trim())
      fd.set('tax_year', extYear)
      fd.set('members', JSON.stringify(members.map(m => ({ name: m.name.trim(), ownership_pct: parseFloat(m.ownership_pct) || 0 }))))
      files.forEach(f => fd.append('files', f))
      priorFiles.forEach(f => fd.append('prior_files', f))
      const res = await fetch('/api/tools/pnl/generate-external', { method: 'POST', body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not generate the P&L. Please try again.')
      }
      await downloadXlsx(res, `${companyName.trim()} - PnL ${extYear}.xlsx`)
      setDone('Downloaded.')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not generate the P&L.')
    } finally {
      setBusy(false)
    }
  }

  const yearInput = (value: string, onChange: (v: string) => void) => (
    <input
      type="number" value={value} onChange={e => onChange(e.target.value)}
      min={2000} max={2100}
      className="w-full h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )

  return (
    <div className="space-y-5">
      {/* Mode toggle */}
      <div className="flex gap-2">
        <button type="button" onClick={() => { setMode('client'); resetFeedback() }}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${mode === 'client' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}>
          <Building2 className="h-4 w-4" /> Existing client
        </button>
        <button type="button" onClick={() => { setMode('external'); resetFeedback() }}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${mode === 'external' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}>
          <Globe className="h-4 w-4" /> External / ad-hoc
        </button>
      </div>

      {mode === 'client' ? (
        <form onSubmit={submitClient} className="space-y-5 rounded-xl border bg-white p-6">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Client account</label>
            <AccountCombobox
              value={accountId}
              displayValue={accountName}
              onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Tax year</label>
            {yearInput(clientYear, setClientYear)}
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={saveToDrive} onChange={e => setSaveToDrive(e.target.checked)} />
            Also save to the client&apos;s Drive &ldquo;3. Tax&rdquo; folder
          </label>
          <p className="text-xs text-muted-foreground">
            Uses the client&apos;s already-processed bank data. If none exists for the year, you&apos;ll get a message —
            process their statements first (this tool never re-parses statements).
          </p>
          <button type="submit" disabled={busy || !accountId}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Generate P&amp;L
          </button>
        </form>
      ) : (
        <form onSubmit={submitExternal} className="space-y-5 rounded-xl border bg-white p-6">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Company name</label>
            <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme Trading LLC"
              className="w-full h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-zinc-700">Members &amp; ownership</label>
              <span className={`text-xs font-medium ${Math.abs(ownershipTotal - 100) <= 0.5 ? 'text-green-600' : 'text-amber-600'}`}>
                Total: {ownershipTotal.toFixed(1)}%
              </span>
            </div>
            <div className="space-y-2">
              {members.map((m, i) => (
                <div key={i} className="flex gap-2">
                  <input value={m.name} placeholder="Member name"
                    onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                    className="flex-1 h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input type="number" value={m.ownership_pct} min={0} max={100} step="0.1" placeholder="%"
                    onChange={e => setMembers(ms => ms.map((x, j) => j === i ? { ...x, ownership_pct: e.target.value } : x))}
                    className="w-24 h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <button type="button" onClick={() => setMembers(ms => ms.filter((_, j) => j !== i))}
                    disabled={members.length === 1}
                    className="inline-flex items-center rounded-md border px-2 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setMembers(ms => [...ms, { name: '', ownership_pct: '0' }])}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
              <Plus className="h-3.5 w-3.5" /> Add member
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Tax year</label>
            {yearInput(extYear, setExtYear)}
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Bank statement CSV(s) — this year</label>
            <label className="flex items-center gap-3 rounded-md border border-dashed px-4 py-3 cursor-pointer hover:border-blue-300 hover:bg-blue-50/40 transition-colors">
              <Upload className="h-5 w-5 text-zinc-400" />
              <span className="text-sm text-zinc-600 truncate">
                {files.length ? `${files.length} file(s) selected` : 'Choose CSV file(s) — max 10 MB each'}
              </span>
              <input type="file" accept=".csv,text/csv" multiple className="hidden"
                onChange={e => setFiles(Array.from(e.target.files || []))} />
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              Prior-year CSV(s) <span className="text-zinc-400 font-normal">(optional — enables the comparative balance sheet)</span>
            </label>
            <label className="flex items-center gap-3 rounded-md border border-dashed px-4 py-3 cursor-pointer hover:border-blue-300 hover:bg-blue-50/40 transition-colors">
              <Upload className="h-5 w-5 text-zinc-400" />
              <span className="text-sm text-zinc-600 truncate">
                {priorFiles.length ? `${priorFiles.length} file(s) selected` : `Choose ${Number(extYear) - 1} CSV file(s)`}
              </span>
              <input type="file" accept=".csv,text/csv" multiple className="hidden"
                onChange={e => setPriorFiles(Array.from(e.target.files || []))} />
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            CSV only. Files are parsed in memory to build the workbook — nothing is saved to the CRM or the database.
          </p>
          <button type="submit" disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Generate P&amp;L
          </button>
        </form>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {done && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="break-words">{done}</span>
        </div>
      )}
    </div>
  )
}
