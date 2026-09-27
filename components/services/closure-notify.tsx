'use client'

import { toast } from 'sonner'
import { SERVICE_TRACKER_SLUGS } from '@/lib/constants'
import type { ClosurePromptOutcome } from '@/lib/portal/closure-client-prompt'

/**
 * Shared bits for the three "Add service" dialogs (contact page, account page,
 * notification cards) when the service is a Company Closure — dev job e2fee7e7.
 * Staff choose whether the client is asked to fill in the closure form, and see
 * what actually happened in a toast.
 */

// lib/services is server-only (it reads the catalog); this is the client-safe
// mirror of the same service type.
export const CLOSURE_SERVICE_TYPE = SERVICE_TRACKER_SLUGS['closure']

export function isClosureServiceType(serviceType: string | null | undefined): boolean {
  return serviceType === CLOSURE_SERVICE_TYPE
}

export function ClosureNotifyCheckbox({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-zinc-300"
      />
      <span>
        Notify client
        <span className="block text-xs text-muted-foreground">
          Sends the client a portal message + email asking them to fill in the closure form.
        </span>
      </span>
    </label>
  )
}

/** Show the outcome of the closure-form prompt. A HELD prompt offers "Send anyway". */
export function showClosurePromptToast(outcome: ClosurePromptOutcome | null | undefined, serviceDeliveryId?: string) {
  if (!outcome) return
  if (outcome.status === 'sent') {
    if (/one channel failed/.test(outcome.reason)) toast.warning(outcome.reason, { duration: 10000 })
    else toast.success(outcome.reason)
    return
  }
  if (outcome.status === 'held' && outcome.canForce && serviceDeliveryId) {
    toast.warning(outcome.reason, {
      duration: 20000,
      action: {
        label: 'Send anyway',
        onClick: async () => {
          try {
            const res = await fetch('/api/crm/admin-actions/closure-prompt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service_delivery_id: serviceDeliveryId, force: true }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'Could not send the message — please try again.')
            showClosurePromptToast(data.client_prompt)
          } catch (err) {
            toast.error(err instanceof Error && err.message ? err.message : 'Could not send the message — please try again.')
          }
        },
      },
    })
    return
  }
  if (outcome.status === 'failed') {
    toast.error(outcome.reason, { duration: 10000 })
    return
  }
  toast.info(outcome.reason, { duration: 8000 })
}
