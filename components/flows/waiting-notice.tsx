import { Clock } from 'lucide-react'

/**
 * Display-only "waiting on the client" banner for flow stages where the next
 * move is the client's (e.g. Wizard Available, Revision Requested, Sent for
 * Signature). No action — it makes the otherwise button-less stage read as an
 * intentional wait rather than a dead end.
 */
export function WaitingNotice({ label }: { label?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-sm text-amber-800">
        {label ?? 'Waiting for the client.'}
      </p>
    </div>
  )
}
