'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Loader2, X, CheckCircle2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

interface GenerateSS4DialogProps {
  open: boolean
  onClose: () => void
  accountId: string
  companyName: string
  state: string | null
  entityType: string | null
  contactName: string
  formationDate: string | null
}

export function GenerateSS4Dialog({
  open, onClose, accountId, companyName, state, entityType, contactName, formationDate,
}: GenerateSS4DialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<{
    success: boolean
    token?: string
    admin_preview?: string
    entity_type?: string
    error?: string
  } | null>(null)

  if (!open) return null

  const entityLabel = entityType?.includes('Multi') ? 'MMLLC' :
    entityType?.includes('Corp') ? 'Corporation' : 'SMLLC'
  const titleLabel = entityLabel === 'SMLLC' ? 'Owner' : entityLabel === 'MMLLC' ? 'Member' : 'President'

  const handleGenerate = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/generate-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate_ss4',
            account_id: accountId,
          }),
        })
        const data = await res.json()

        if (res.status === 409) {
          setResult({ success: true, token: data.token, error: `SS-4 already exists (${data.status})` })
          toast.info(`SS-4 already exists for ${companyName}`)
          router.refresh()
          return
        }

        if (!res.ok) {
          toast.error(data.error || 'Failed to generate SS-4')
          return
        }

        setResult({ success: true, token: data.token, admin_preview: data.admin_preview, entity_type: data.entity_type })
        toast.success(`SS-4 created for ${companyName}`)
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
            <h2 className="text-lg font-semibold">Generate SS-4 (EIN Application)</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {!result ? (
            <>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">LLC Name (Line 1)</label>
                  <p className="text-sm font-medium mt-0.5">{companyName}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">State (Line 6)</label>
                    <p className="text-sm mt-0.5">{state || '—'}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Entity Type</label>
                    <p className="text-sm mt-0.5">{entityLabel}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Responsible Party (Line 3)</label>
                    <p className="text-sm mt-0.5">{contactName}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</label>
                    <p className="text-sm mt-0.5">{titleLabel}</p>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Formation Date (Line 10)</label>
                  <p className="text-sm mt-0.5">{formationDate || '—'}</p>
                </div>
              </div>

              <div className="text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="font-medium text-amber-800 mb-1">After client signs:</p>
                <p>Luca will receive a task to fax the SS-4 to the IRS.</p>
                <p>Third party designee: Tony Durante LLC</p>
              </div>
            </>
          ) : (
            <div className={`rounded-lg p-4 ${result.success ? 'bg-emerald-50' : 'bg-red-50'}`}>
              <div className="flex items-start gap-2">
                <CheckCircle2 className={`h-5 w-5 mt-0.5 ${result.success ? 'text-emerald-600' : 'text-red-600'}`} />
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {result.error || `SS-4 created (${result.entity_type})`}
                  </p>
                  {result.admin_preview && (
                    <a
                      href={result.admin_preview}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Preview SS-4
                    </a>
                  )}
                  {!result.error && (
                    <p className="text-xs text-muted-foreground">
                      The client will see this in the portal Sign Documents section.
                    </p>
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
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Generate SS-4
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
