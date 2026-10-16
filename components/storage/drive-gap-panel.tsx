'use client'

import { useState } from 'react'
import { toast } from 'sonner'

interface GapFile { id: string; name: string; path: string; kind: 'missing' | 'in_crm_on_drive' | 'same_name_stored'; size: number | null }
interface GapReport { accountId: string; company: string; total: number; counts: Record<string, number>; files: GapFile[] }

const KIND_LABEL: Record<GapFile['kind'], string> = {
  missing: 'Not in storage',
  in_crm_on_drive: 'In the CRM, still on Drive',
  same_name_stored: 'Same name already in storage',
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'The Drive check could not run.')
  return data as T
}

/** Owners only. Reads each company's old Drive folder and says what storage does not have — it changes nothing. */
export function DriveGapPanel() {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [reports, setReports] = useState<GapReport[]>([])
  const [failed, setFailed] = useState<Array<{ company: string; why: string }>>([])
  const [open, setOpen] = useState<string | null>(null)

  const run = async () => {
    setRunning(true); setReports([]); setFailed([]); setDone(0)
    try {
      const { companies } = await getJson<{ companies: Array<{ accountId: string; company: string }> }>('/api/crm-store/drive-gap')
      setTotal(companies.length)
      for (const c of companies) {
        try {
          const r = await getJson<GapReport>(`/api/crm-store/drive-gap?account=${encodeURIComponent(c.accountId)}`)
          setReports((list) => [...list, r])
        } catch (e) {
          setFailed((f) => [...f, { company: c.company, why: e instanceof Error ? e.message : 'failed' }])
        }
        setDone((n) => n + 1)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The Drive check could not run.')
    } finally { setRunning(false) }
  }

  const needing = reports.filter((r) => r.files.length > 0).sort((a, b) => (b.counts.missing ?? 0) - (a.counts.missing ?? 0))
  const missingTotal = reports.reduce((n, r) => n + (r.counts.missing ?? 0), 0)

  const download = () => {
    const rows = [['Company', 'Kind', 'Folder', 'File', 'Size (bytes)']]
    for (const r of needing) for (const f of r.files) rows.push([r.company, KIND_LABEL[f.kind], f.path, f.name, f.size == null ? '' : String(f.size)])
    const csv = rows.map((row) => row.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'drive-vs-storage.csv'; a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3 text-sm" data-testid="drive-gap-panel">
      <p className="text-zinc-600">
        Reads each company&apos;s old Google Drive folder and lists the files storage does not have. It only reads — nothing is moved, changed or deleted.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={running} onClick={run} className="rounded-md bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-50">
          {running ? `Checking… ${done} of ${total}` : reports.length ? 'Check again' : 'Check all companies'}
        </button>
        {needing.length > 0 && !running && <button type="button" onClick={download} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 hover:bg-zinc-50">Download the list (CSV)</button>}
      </div>
      {reports.length > 0 && (
        <p className="text-zinc-700">
          {reports.length} {reports.length === 1 ? 'company' : 'companies'} checked · <strong>{missingTotal}</strong> {missingTotal === 1 ? 'file' : 'files'} not in storage · {needing.length} {needing.length === 1 ? 'company needs' : 'companies need'} a look
        </p>
      )}
      {failed.length > 0 && <p className="text-amber-700">{failed.length} could not be checked: {failed.map((f) => `${f.company} (${f.why})`).join('; ')}</p>}
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
        {needing.map((r) => (
          <li key={r.accountId} className="p-2">
            <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === r.accountId ? null : r.accountId)}>
              <span className="font-medium">{r.company}</span>
              <span className="text-xs text-zinc-500">{r.counts.missing ?? 0} not in storage · {r.counts.in_crm_on_drive ?? 0} in the CRM on Drive · {r.counts.same_name_stored ?? 0} same name stored · of {r.total}</span>
            </button>
            {open === r.accountId && (
              <ul className="mt-2 space-y-1 text-xs">
                {r.files.map((f) => (
                  <li key={f.id} className="flex flex-wrap gap-2">
                    <span className={f.kind === 'missing' ? 'text-red-700' : 'text-zinc-500'}>{KIND_LABEL[f.kind]}</span>
                    <span>{f.path ? `${f.path} › ` : ''}{f.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {!running && reports.length > 0 && needing.length === 0 && <li className="p-3 text-zinc-600">Every checked company has all its Drive files in storage.</li>}
      </ul>
    </div>
  )
}
