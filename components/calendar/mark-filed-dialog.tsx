'use client'

import { useState } from 'react'
import { X, Loader2, Upload, ExternalLink, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { RenewalRow } from '@/app/(dashboard)/calendar/page'

const STATE_PORTALS: Record<string, { name: string; fee: string }> = {
  Wyoming: { name: 'sos.wyo.gov', fee: '$60' },
  Florida: { name: 'sunbiz.org', fee: '$138.75' },
  Delaware: { name: 'corp.delaware.gov', fee: '$300' },
  Massachusetts: { name: 'sec.state.ma.us', fee: '$500' },
}

interface Props {
  row: RenewalRow
  onClose: () => void
  onFiled: () => void
}

export function MarkFiledDialog({ row, onClose, onFiled }: Props) {
  const [filedDate, setFiledDate] = useState<string>(() => new Date().toISOString().split('T')[0])
  // The cycle year this filing is FOR. Defaults to the DUE date's year (the
  // cycle being satisfied), not the filed date — a stuck 2025 row marked
  // filed today is usually the 2025 filing. Clamped to what the server
  // accepts (at most next year) so a far-future row can't default to a
  // value the API would reject. Staff can override.
  const [filingForYear, setFilingForYear] = useState<string>(() => {
    const due = parseInt(row.due_date.slice(0, 4), 10)
    const cap = new Date().getFullYear() + 1
    return String(Number.isNaN(due) ? cap - 1 : Math.min(due, cap))
  })
  const [file, setFile] = useState<File | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const isRA = row.kind === 'ra'
  const portal = !isRA && row.state_of_formation ? STATE_PORTALS[row.state_of_formation] : null
  const year = filingForYear
  // Continuous range — a record years behind must be able to name any owed
  // year (the old sparse set had holes, e.g. a 2022-due row offered no 2024).
  // Capped to what the server accepts relative to the filed date
  // (filedYear-10 … filedYear+1), so the default can never 400.
  const yearOptions = (() => {
    const current = new Date().getFullYear()
    const filedYear = parseInt(filedDate.slice(0, 4), 10) || current
    const dueYear = parseInt(row.due_date.slice(0, 4), 10)
    const lo = Math.max(filedYear - 10, Math.min(dueYear - 1, current - 1))
    const hi = Math.min(filedYear + 1, Math.max(dueYear, current + 1))
    const years: number[] = []
    for (let y = lo; y <= hi; y++) years.push(y)
    return years
  })()

  const canSubmit = !!file && !!filedDate && !submitting

  function acceptFile(f: File | null | undefined) {
    if (!f) return
    if (f.type && !f.type.includes('pdf')) {
      toast.error(`Receipt must be a PDF. Got: ${f.type || 'unknown'}.`)
      return
    }
    setFile(f)
  }

  function handleDrag(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (submitting) return
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (submitting) return
    acceptFile(e.dataTransfer.files?.[0])
  }

  async function handleSubmit() {
    if (!file) {
      toast.error('Receipt PDF is required.')
      return
    }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('account_id', row.account_id)
      fd.append('kind', row.kind)
      fd.append('filed_date', filedDate)
      fd.append('filing_for_year', filingForYear)
      if (row.delivery_id) fd.append('delivery_id', row.delivery_id)
      fd.append('receipt', file)

      const res = await fetch('/api/calendar/file-renewal', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to file renewal — please try again.')
      }
      toast.success(`${isRA ? 'RA Renewal' : 'Annual Report'} ${year} filed for ${row.company_name}.`)
      onFiled()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to file renewal.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={() => !submitting && onClose()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col pointer-events-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Mark Filed — {isRA ? 'RA Renewal' : 'Annual Report'} {year}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {row.company_name}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="p-1 rounded hover:bg-zinc-100 disabled:opacity-50"
              aria-label="Close"
            >
              <X className="h-5 w-5 text-zinc-500" />
            </button>
          </div>

          {/* Read-only context block */}
          <div className="px-6 py-4 border-b bg-zinc-50/50 space-y-2 text-sm">
            <div className="grid grid-cols-[110px_1fr] gap-y-1.5 text-xs">
              <span className="text-zinc-500">State</span>
              <span className="font-medium">{row.state_of_formation ?? '—'}</span>

              <span className="text-zinc-500">Provider</span>
              <span className="font-medium">{row.provider ?? <em className="text-zinc-400">none</em>}</span>

              <span className="text-zinc-500">Agent</span>
              <span className="font-medium">{row.agent_name ?? <em className="text-zinc-400">none</em>}</span>

              <span className="text-zinc-500">RA address</span>
              <span className="font-medium">{row.ra_address_line ?? <em className="text-zinc-400">—</em>}</span>

              {row.ra_county && (
                <>
                  <span className="text-zinc-500">County</span>
                  <span className="font-medium">{row.ra_county}</span>
                </>
              )}

              {portal && (
                <>
                  <span className="text-zinc-500">State portal</span>
                  <span className="font-medium">
                    {portal.name} <span className="text-zinc-500 ml-1">· fee {portal.fee}</span>
                  </span>
                </>
              )}

              <span className="text-zinc-500">Drive folder</span>
              <span>
                {row.drive_folder_url ? (
                  <a
                    href={row.drive_folder_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-amber-600 inline-flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Missing — cannot save receipt
                  </span>
                )}
              </span>
            </div>
            {isRA && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2">
                Renew on Harbor Compliance ($35). Receipt will save to <code className="text-[10px]">Compliance/RA Renewal {year}.pdf</code>.
              </p>
            )}
            {!isRA && (
              <p className="text-[11px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-2 py-1 mt-2">
                File on the state portal. Receipt will save to <code className="text-[10px]">Compliance/Annual Report {year}.pdf</code>.
              </p>
            )}
          </div>

          {/* Inputs */}
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <div>
              <label htmlFor="filed-date" className="block text-xs font-medium text-zinc-600 mb-1">
                Filed date <span className="text-red-500">*</span>
              </label>
              <input
                id="filed-date"
                type="date"
                value={filedDate}
                onChange={e => setFiledDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="filing-for-year" className="block text-xs font-medium text-zinc-600 mb-1">
                Filing for year <span className="text-red-500">*</span>
              </label>
              <select
                id="filing-for-year"
                value={filingForYear}
                onChange={e => setFilingForYear(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {yearOptions.map(y => (
                  <option key={y} value={String(y)}>{y}</option>
                ))}
              </select>
              <p className="text-[11px] text-zinc-400 mt-1">
                The compliance year this filing satisfies. The next due date becomes this year + 1.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">
                Receipt PDF <span className="text-red-500">*</span>
              </label>
              <label
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                className={cn(
                  'flex items-center justify-center gap-2 w-full px-3 py-6 text-sm border-2 border-dashed rounded-md cursor-pointer transition-colors',
                  dragActive
                    ? 'border-blue-500 bg-blue-50'
                    : file
                      ? 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50'
                      : 'border-zinc-300 hover:bg-zinc-50',
                )}
              >
                <Upload className={cn('h-4 w-4 shrink-0', dragActive ? 'text-blue-600' : 'text-zinc-500')} />
                <span className="truncate">
                  {dragActive
                    ? 'Drop PDF here…'
                    : file
                      ? file.name
                      : 'Drop a PDF here, or click to browse'}
                </span>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={e => acceptFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </label>
              <p className="text-[11px] text-zinc-400 mt-1">
                Required per SOP v7.0 — file is saved to Drive and the matching SD is closed.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t shrink-0">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || !row.drive_folder_url}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Mark filed
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
