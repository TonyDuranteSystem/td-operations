import Link from 'next/link'
import { PhoneCall } from 'lucide-react'
import type { ExistingClientNewCall } from '@/lib/leads/existing-client-new-calls'

/**
 * Always-visible banner (independent of the current tab/filter) so a rebooked
 * call from an already-known client — which can otherwise ONLY show up under
 * the Converted or Clients tab — never goes unnoticed on the page staff
 * actually look at day to day. See dev job a28a0d65.
 */
export function ExistingClientNewCalls({ items }: { items: ExistingClientNewCall[] }) {
  if (items.length === 0) return null

  return (
    <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
      <div className="flex items-center gap-2 mb-2 px-1">
        <PhoneCall className="h-4 w-4 text-emerald-700 shrink-0" />
        <h2 className="text-sm font-semibold text-emerald-900">
          Existing client{items.length > 1 ? 's' : ''} with a new call
        </h2>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map(item => (
          <li key={item.id}>
            <Link
              href={`/leads/${item.id}`}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-emerald-100 transition-colors"
            >
              <span className="font-medium text-emerald-900 truncate">{item.full_name}</span>
              <span className="text-xs text-emerald-700 shrink-0">
                {new Date(item.call_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
