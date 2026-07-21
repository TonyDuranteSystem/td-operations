'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Ban, RotateCcw } from 'lucide-react'
import {
  deactivateServiceDelivery,
  reactivateServiceDelivery,
} from '@/app/(dashboard)/accounts/[id]/actions'

/**
 * Service types whose renewal is driven by an account-level date + a nightly
 * cron that re-creates the SD on `Client` accounts. For these we offer to also
 * clear the account renewal date so the cron stops managing it. Mirrors
 * RENEWAL_DATE_COLUMN in lib/operations/service-delivery.ts.
 */
const RENEWAL_SERVICE_TYPES = new Set(['State RA Renewal', 'State Annual Report'])

export function DeactivateServiceButton({
  deliveryId,
  serviceType,
  serviceName,
  updatedAt,
  accountType,
}: {
  deliveryId: string
  serviceType: string
  serviceName: string
  updatedAt: string
  accountType: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const offerClear = RENEWAL_SERVICE_TYPES.has(serviceType) && accountType === 'Client'
  const [clearDate, setClearDate] = useState(true) // default on for renewal services
  const [isPending, startTransition] = useTransition()

  function handleConfirm() {
    startTransition(async () => {
      const res = await deactivateServiceDelivery(deliveryId, updatedAt, {
        clearRenewalDate: offerClear ? clearDate : false,
        reason: reason.trim() || undefined,
      })
      if (!res.success) {
        toast.error(res.error ?? 'Failed to deactivate service')
        return
      }
      const parts: string[] = []
      if (res.tasks_cancelled) parts.push(`${res.tasks_cancelled} task${res.tasks_cancelled === 1 ? '' : 's'} cancelled`)
      if (res.renewal_date_cleared) parts.push('renewal date cleared')
      toast.success(`${serviceName} deactivated${parts.length ? ` (${parts.join(', ')})` : ''}`)
      setOpen(false)
      setReason('')
      router.refresh()
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 hover:underline shrink-0"
        title="Deactivate this service"
      >
        <Ban className="h-3.5 w-3.5" /> Deactivate
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isPending) setOpen(false)
          }}
        >
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">Deactivate service?</h3>
            <p className="text-sm text-zinc-600 mb-4">
              Deactivate <span className="font-medium text-zinc-900">{serviceName}</span>? It will
              leave the active list, disappear from the client portal, and its open tasks will be
              cancelled.
            </p>

            {offerClear && (
              <label className="flex items-start gap-2 mb-4 p-3 rounded-md bg-amber-50 border border-amber-200">
                <input
                  type="checkbox"
                  checked={clearDate}
                  onChange={(e) => setClearDate(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-xs text-amber-900">
                  Also stop the renewal — clears this account&apos;s renewal date so the nightly job
                  won&apos;t re-create the service. Leave checked unless you still want us to manage
                  this renewal.
                </span>
              </label>
            )}

            <label className="block text-xs font-medium text-zinc-600 mb-1">Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. client handles this themselves"
              className="w-full text-sm border border-zinc-200 rounded-md px-2.5 py-1.5 mb-5"
            />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={isPending}
                className="px-3 py-1.5 text-sm rounded-md border border-zinc-200 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isPending ? 'Deactivating…' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function ReactivateServiceButton({
  deliveryId,
  serviceName,
  updatedAt,
}: {
  deliveryId: string
  serviceName: string
  updatedAt: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function handleReactivate() {
    startTransition(async () => {
      const res = await reactivateServiceDelivery(deliveryId, updatedAt)
      if (!res.success) {
        toast.error(res.error ?? 'Failed to reactivate service')
        return
      }
      toast.success(`${serviceName} reactivated`)
      if (res.renewal_date_empty) {
        toast.warning(
          'Renewal date is empty — set it on the account for this renewal to be managed again.',
        )
      }
      router.refresh()
    })
  }

  return (
    <button
      type="button"
      onClick={handleReactivate}
      disabled={isPending}
      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline shrink-0 disabled:opacity-50"
      title="Reactivate this service"
    >
      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
      Reactivate
    </button>
  )
}
