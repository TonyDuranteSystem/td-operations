'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck, Loader2, X, CheckCircle2, FileText } from 'lucide-react'
import { toast } from 'sonner'

interface GenerateAttestationDialogProps {
  open: boolean
  onClose: () => void
  accountId: string
  companyName: string
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Generate an Attestation of Beneficial Ownership — one generic page (no bank name) listing every
 * individual who owns 25% or more. Owners, percentages, birth dates and nationalities are read from
 * the CRM; if anything is missing or does not add up, generation stops and says what to fix.
 * The file is saved in the company's storage and is NOT shown to the client or sent to them.
 */
export function GenerateAttestationDialog({
  open, onClose, accountId, companyName,
}: GenerateAttestationDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [effectiveDate, setEffectiveDate] = useState(todayISO())
  const [result, setResult] = useState<{
    file_name?: string
    owners?: Array<{ name: string; pct: number }>
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
            action: 'generate_ownership_attestation',
            account_id: accountId,
            effective_date: effectiveDate,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data.error || 'Failed to generate the attestation')
          return
        }
        setResult({ file_name: data.file_name, owners: data.owners })
        toast.success(`Attestation created for ${companyName}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Error generating the attestation — please try again.')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Generate Attestation of Beneficial Ownership</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {result ? (
            <div className="rounded-lg p-4 bg-emerald-50">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-5 w-5 mt-0.5 text-emerald-600" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Attestation created</p>
                  <p className="text-xs text-zinc-600">
                    {companyName}: {(result.owners ?? []).map(o => `${o.name} (${o.pct}%)`).join(', ')}
                  </p>
                  <p className="text-xs text-zinc-500">
                    Saved in the company&apos;s Banking folder. It is not shown to the client and nothing was sent — attach it to a chat message when it is needed.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</label>
                <p className="text-sm font-medium mt-0.5">{companyName}</p>
              </div>
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
                <p className="text-xs text-blue-800">
                  One generic page for any bank: every individual with 25% or more, read from the CRM (Members section,
                  or the single owner), with date of birth and nationality from their contact record. If anything is
                  missing or the percentages do not add up to 100%, generation stops and tells you what to fix.
                  The signature line is left blank.
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Date on the letter</label>
                <input
                  type="date"
                  value={effectiveDate}
                  onChange={e => setEffectiveDate(e.target.value)}
                  className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-zinc-50/50 rounded-b-xl">
          {result ? (
            <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200">
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
                Generate Attestation
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
