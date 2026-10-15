'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'

/** Re-reads the page from the server (the list is a live read, never kept on the visitor's side). */
export function RefreshButton() {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <>
      <button type="button" onClick={() => start(() => router.refresh())} className="text-blue-700 underline">
        Refresh
      </button>
      {pending && <span className="ml-2" role="status">Updating…</span>}
    </>
  )
}
