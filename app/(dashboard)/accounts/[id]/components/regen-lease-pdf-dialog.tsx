'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, X, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface RegenLeasePdfDialogProps {
  open: boolean
  onClose: () => void
  leaseId: string
  signedAt?: string | null
  termStartDate?: string | null
  termEndDate?: string | null
}

function toInputDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.split('T')[0]
}

export function RegenLeasePdfDialog({
  open,
  onClose,
  leaseId,
  signedAt,
  termStartDate,
  termEndDate,
}: RegenLeasePdfDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [done, setDone] = useState(false)

  // Read-only: the copy is regenerated from the lease's OWN recorded dates, not
  // typed in. Typing dates here used to let a filed "signed" copy differ from what
  // the client actually executed.
  const signedDateStr = toInputDate(signedAt)
  const startDateStr = toInputDate(termStartDate)
  const endDateStr = toInputDate(termEndDate)

  if (!open) return null

  const handleRegen = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/regen-lease-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lease_id: leaseId }),
        })
        const data = await res.json()
        if (!res.ok) {
          const msg = data.error || 'Failed to regenerate PDF'
          toast.error(msg)
          return
        }
        setDone(true)
        toast.success('Lease PDF regenerated and uploaded to Drive')
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Error regenerating PDF')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Regenerate Lease PDF</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {done ? (
            <div className="flex items-start gap-2 rounded-lg bg-emerald-50 p-4">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              <p className="text-sm font-medium text-emerald-800">
                PDF regenerated and saved to Drive. The portal document has been updated.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Regenerates a clean signed copy of this executed lease — using the lease&apos;s own
                recorded dates — and replaces the existing PDF in Drive and the client portal.
                Only works on a signed lease.
              </p>

              <div className="space-y-2 rounded-lg bg-zinc-50 border p-3 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Signed date</span><span className="font-medium">{signedDateStr || '— not signed —'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Term start</span><span className="font-medium">{startDateStr || '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Term end</span><span className="font-medium">{endDateStr || '—'}</span></div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-zinc-50/50 rounded-b-xl">
          {done ? (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
            >
              Close
            </button>
          ) : (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-800">
                Cancel
              </button>
              <button
                onClick={handleRegen}
                disabled={isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Regenerate PDF
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
