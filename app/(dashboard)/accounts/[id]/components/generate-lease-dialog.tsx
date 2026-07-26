'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Home, Loader2, X, CheckCircle2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

interface GenerateLeaseDialogProps {
  open: boolean
  onClose: () => void
  accountId: string
  companyName: string
  /** Pre-fills the start date. When absent, defaults to today. */
  formationDate?: string | null
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function isISODate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v)
}

export function GenerateLeaseDialog({ open, onClose, accountId, companyName, formationDate }: GenerateLeaseDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<{
    success: boolean
    token?: string
    admin_preview?: string
    suite_number?: string
    error?: string
  } | null>(null)

  const [monthlyRent, setMonthlyRent] = useState('100')
  const [securityDeposit, setSecurityDeposit] = useState('150')

  // Pre-fill the start with the company's formation date ONLY when the company
  // was formed THIS year (the mid-year-formation case). A years-old formation
  // date would silently create a back-dated, past-year lease, so fall back to
  // today. Either way it stays editable.
  const fmtStart = formationDate ? String(formationDate).slice(0, 10) : ''
  const initialStart = isISODate(fmtStart) && Number(fmtStart.slice(0, 4)) === new Date().getFullYear()
    ? fmtStart
    : todayISO()
  const [startDate, setStartDate] = useState(initialStart)
  const [endDate, setEndDate] = useState(`${initialStart.slice(0, 4)}-12-31`)
  const [endEdited, setEndEdited] = useState(false)

  const handleStartChange = (v: string) => {
    setStartDate(v)
    // Keep the end on Dec 31 of the chosen start year — but only while staff
    // haven't hand-edited the end themselves (don't clobber a custom term).
    if (isISODate(v) && !endEdited) setEndDate(`${v.slice(0, 4)}-12-31`)
  }

  const handleEndChange = (v: string) => {
    setEndDate(v)
    setEndEdited(true)
  }

  if (!open) return null

  const handleGenerate = () => {
    if (!startDate || !endDate) {
      toast.error('Please set both a start and end date.')
      return
    }
    if (endDate < startDate) {
      toast.error('End date cannot be before the start date.')
      return
    }
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/generate-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate_lease',
            account_id: accountId,
            // suite_number omitted — auto-assigned by backend
            // Number.isFinite preserves an intentional 0 (|| would rewrite it).
            monthly_rent: Number.isFinite(parseInt(monthlyRent)) ? parseInt(monthlyRent) : 100,
            security_deposit: Number.isFinite(parseInt(securityDeposit)) ? parseInt(securityDeposit) : 150,
            term_start_date: startDate,
            term_end_date: endDate,
            effective_date: startDate,
          }),
        })
        const data = await res.json()

        if (res.status === 409) {
          setResult({ success: true, token: data.token, error: `Lease already exists (${data.status})` })
          toast.info(`Lease already exists for ${companyName}`)
          router.refresh()
          return
        }

        if (!res.ok) {
          toast.error(data.error || 'Failed to generate lease')
          return
        }

        setResult({ success: true, token: data.token, admin_preview: data.admin_preview, suite_number: data.suite_number })
        toast.success(`Lease created for ${companyName} — Suite ${data.suite_number}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Home className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Generate Lease Agreement</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {!result ? (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tenant</label>
                <p className="text-sm font-medium mt-0.5">{companyName}</p>
              </div>

              <div className="space-y-3">
                <div className="text-xs text-muted-foreground bg-blue-50 rounded-lg p-3">
                  Suite number will be auto-assigned (next available 3D-XXX)
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Start Date</label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={e => handleStartChange(e.target.value)}
                      className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">End Date</label>
                    <input
                      type="date"
                      value={endDate}
                      onChange={e => handleEndChange(e.target.value)}
                      className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Monthly Rent ($)</label>
                    <input
                      type="number"
                      value={monthlyRent}
                      onChange={e => setMonthlyRent(e.target.value)}
                      className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Security Deposit ($)</label>
                    <input
                      type="number"
                      value={securityDeposit}
                      onChange={e => setSecurityDeposit(e.target.value)}
                      className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              <div className="text-xs text-muted-foreground bg-zinc-50 rounded-lg p-3 space-y-1">
                <p>Premises: 10225 Ulmerton Rd, Largo, FL 33771</p>
                <p>Term: {startDate || '—'} → {endDate || '—'}</p>
                <p>Yearly rent: ${(parseInt(monthlyRent) || 100) * 12}</p>
              </div>
            </>
          ) : (
            <div className={`rounded-lg p-4 ${result.success ? 'bg-emerald-50' : 'bg-red-50'}`}>
              <div className="flex items-start gap-2">
                <CheckCircle2 className={`h-5 w-5 mt-0.5 ${result.success ? 'text-emerald-600' : 'text-red-600'}`} />
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {result.error || `Lease created — Suite ${result.suite_number}`}
                  </p>
                  {result.admin_preview && (
                    <a
                      href={result.admin_preview}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Preview Lease
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-zinc-50/50 rounded-b-xl">
          {!result ? (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-800">
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Home className="h-4 w-4" />}
                Generate Lease
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
