'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

/**
 * New Calendar — its own error screen, so a fault here never reaches the rest of the CRM.
 * Says plainly that nothing was changed (the page only reads).
 */
export default function NewCalendarError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter()
  const [, start] = useTransition()
  return (
    <div className="p-6 lg:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
        <p className="font-medium">Could not load this page.</p>
        <p className="mt-1">Nothing was changed. This page only reads. Try again, and tell us if it keeps happening.</p>
        <button type="button" onClick={() => start(() => { router.refresh(); reset() })} className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100">
          Try again
        </button>
        <p className="mt-3">
          <Link href="/calendar" prefetch={false} className="underline">Renewals and annual reports (Mark Filed)</Link> are on the existing Calendar and can still be opened.
        </p>
      </div>
    </div>
  )
}
