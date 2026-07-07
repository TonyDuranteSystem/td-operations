'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Loader2, X, CheckCircle2, FileText } from 'lucide-react'
import { toast } from 'sonner'

interface GenerateIntercompanyDialogProps {
  open: boolean
  onClose: () => void
  accountId: string
  companyName: string
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Generate an Intercompany Transfer Agreement (operating LLC ↔ treasury/holding
 * member company). All data — addresses, EIN, ownership % — is read from the
 * CRM (account + Members section). Requires exactly one company-type member.
 */
export function GenerateIntercompanyDialog({
  open, onClose, accountId, companyName,
}: GenerateIntercompanyDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [effectiveDate, setEffectiveDate] = useState(todayISO())
  const [result, setResult] = useState<{
    file_name?: string
    treasury_company?: string
    ownership_pct?: number
  } | null>(null)

  useEffect(() => {
    if (open) {
      setResult(null)
      setEffectiveDate(todayISO())
    }
  }, [open])

  if (!open) return null

  const handleGenerate = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/generate-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate_intercompany',
            account_id: accountId,
            effective_date: effectiveDate,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data.error || 'Failed to generate Intercompany Agreement')
          return
        }
        setResult({ file_name: data.file_name, treasury_company: data.treasury_company, ownership_pct: data.ownership_pct })
        toast.success(`Intercompany Agreement created for ${companyName}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Error generating the agreement — please try again.')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Generate Intercompany Agreement</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {result ? (
            <div className="rounded-lg p-4 bg-emerald-50">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-5 w-5 mt-0.5 text-emerald-600" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Intercompany Transfer Agreement created</p>
                  <p className="text-xs text-zinc-600">
                    {companyName} ↔ <strong>{result.treasury_company}</strong> ({result.ownership_pct}%)
                  </p>
                  <p className="text-xs text-zinc-500">
                    Filed to the company Drive folder and visible in the client portal Documents page.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Operating Company</label>
                <p className="text-sm font-medium mt-0.5">{companyName}</p>
              </div>
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
                <p className="text-xs text-blue-800">
                  The treasury company, its ownership percentage, addresses and EINs are read from the CRM
                  (account record + Members section). If the member data is incomplete, generation stops
                  with an error telling you what to fill in.
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Effective Date</label>
                <input
                  type="date"
                  value={effectiveDate}
                  max={todayISO()}
                  onChange={e => setEffectiveDate(e.target.value)}
                  className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
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
                Generate Agreement
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
