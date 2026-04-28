'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Loader2, X, CheckCircle2, ExternalLink, RefreshCw, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

interface GenerateOADialogProps {
  open: boolean
  onClose: () => void
  accountId: string
  companyName: string
  state: string | null
  entityType: string | null
  contactName: string
  formationDate: string | null
  ein: string | null
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function minDateISO() {
  return new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function GenerateOADialog({
  open, onClose, accountId, companyName, state, entityType, contactName, formationDate, ein,
}: GenerateOADialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<{
    success: boolean
    token?: string
    admin_preview?: string
    error?: string
    entity_type?: string
  } | null>(null)

  const [managerName, setManagerName] = useState(contactName)
  const [effectiveDate, setEffectiveDate] = useState(todayISO())

  // Recreate flow: shown when a 409 is returned (OA already exists)
  const [existingOA, setExistingOA] = useState<{ token: string; status: string; effective_date?: string } | null>(null)
  const [recreateDate, setRecreatDate] = useState(todayISO())

  useEffect(() => {
    if (open) {
      setResult(null)
      setExistingOA(null)
      setRecreatDate(todayISO())
      setEffectiveDate(todayISO())
      setManagerName(contactName)
    }
  }, [open, contactName])

  if (!open) return null

  const entityLabel = entityType?.includes('Multi') ? 'MMLLC' : 'SMLLC'

  const handleGenerate = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/generate-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate_oa',
            account_id: accountId,
            manager_name: managerName,
            effective_date: effectiveDate,
          }),
        })
        const data = await res.json()

        if (res.status === 409) {
          setExistingOA({ token: data.token, status: data.status, effective_date: data.effective_date })
          setRecreatDate(effectiveDate)
          return
        }

        if (!res.ok) {
          toast.error(data.error || 'Failed to generate OA')
          return
        }

        setResult({ success: true, token: data.token, admin_preview: data.admin_preview, entity_type: data.entity_type })
        toast.success(`OA created for ${companyName}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error')
      }
    })
  }

  const handleRecreate = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/generate-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate_oa',
            account_id: accountId,
            manager_name: managerName,
            effective_date: recreateDate,
            force_recreate: true,
          }),
        })
        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to recreate OA')
          return
        }

        setExistingOA(null)
        setResult({ success: true, token: data.token, admin_preview: data.admin_preview, entity_type: data.entity_type })
        toast.success(`OA recreated for ${companyName}`)
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
            <FileText className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Generate Operating Agreement</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">

          {/* ── Existing OA conflict ── */}
          {existingOA && !result && (
            <div className="space-y-4">
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 space-y-1">
                <div className="flex items-center gap-2 text-amber-800 font-medium text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  OA already exists
                </div>
                <p className="text-xs text-amber-700">
                  Token: <span className="font-mono">{existingOA.token}</span> · Status: <strong>{existingOA.status}</strong>
                  {existingOA.effective_date && <> · Effective: {existingOA.effective_date}</>}
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-sm text-zinc-700">
                  To create a new OA, the existing one (and any associated signatures) will be deleted.
                  Choose an effective date — maximum 60 days in the past.
                </p>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">New Effective Date</label>
                  <input
                    type="date"
                    value={recreateDate}
                    min={minDateISO()}
                    max={todayISO()}
                    onChange={e => setRecreatDate(e.target.value)}
                    className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-zinc-500 mt-1">Earliest allowed: {minDateISO()}</p>
                </div>
              </div>
            </div>
          )}

          {/* ── Success ── */}
          {result && (
            <div className={`rounded-lg p-4 ${result.success ? 'bg-emerald-50' : 'bg-red-50'}`}>
              <div className="flex items-start gap-2">
                <CheckCircle2 className={`h-5 w-5 mt-0.5 ${result.success ? 'text-emerald-600' : 'text-red-600'}`} />
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {result.error || `${result.entity_type} Operating Agreement created`}
                  </p>
                  {result.admin_preview && (
                    <a
                      href={result.admin_preview}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Preview OA
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Create form ── */}
          {!existingOA && !result && (
            <>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</label>
                  <p className="text-sm font-medium mt-0.5">{companyName}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">State</label>
                    <p className="text-sm mt-0.5">{state || '—'}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Entity Type</label>
                    <p className="text-sm mt-0.5">{entityLabel}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Formation Date</label>
                    <p className="text-sm mt-0.5">{formationDate || '—'}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">EIN</label>
                    <p className="text-sm mt-0.5">{ein || '—'}</p>
                  </div>
                </div>
              </div>

              <hr />

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Manager Name</label>
                  <input
                    type="text"
                    value={managerName}
                    onChange={e => setManagerName(e.target.value)}
                    className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Effective Date</label>
                  <input
                    type="date"
                    value={effectiveDate}
                    min={minDateISO()}
                    max={todayISO()}
                    onChange={e => setEffectiveDate(e.target.value)}
                    className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-zinc-500 mt-1">Maximum 60 days in the past</p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-zinc-50/50 rounded-b-xl">
          {result ? (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
            >
              Done
            </button>
          ) : existingOA ? (
            <>
              <button onClick={() => setExistingOA(null)} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-800">
                Cancel
              </button>
              <button
                onClick={handleRecreate}
                disabled={isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Recreate OA
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-800">
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Generate OA
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
