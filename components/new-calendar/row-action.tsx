'use client'

/**
 * New Calendar — what a row's last cell does. A step whose layout asks for a Calendar pop-up opens it RIGHT HERE on the row
 * (the Calendar is where the team works every day); every other row opens its workspace in a floating window (the Calendar only SHOWS the stage;
 * all acting happens in the workspace — Antonio 2026-10-16: no "Done" buttons).
 * No service or step name is written here: the pop-up comes from the step's layout data (`row.popup`).
 */

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { OpenInWindowLink } from '@/components/windows/open-in-window-link'
import { ClosureWrapupDialog } from '@/components/open-services/closure-wrapup-dialog'
import type { CalendarRow } from '@/lib/new-calendar/types'

export function RowAction({ row }: { row: CalendarRow }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  if (row.popup === 'closure_wrapup') {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Review wrap-up for ${row.name}`}
          className="whitespace-nowrap rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Review wrap-up
        </button>
        <Link href={row.href} prefetch={false} aria-label={`Open job page for ${row.name}`} className="mt-1 block text-xs text-zinc-500 underline hover:text-zinc-700">
          Job page
        </Link>
        {open && (
          <ClosureWrapupDialog
            jobId={row.id}
            name={row.name}
            subtitle={`${row.serviceType} · ${row.stepNo ? `Step ${row.stepNo}: ` : ''}${row.stage || 'no step'}`}
            onClose={close}
          />
        )}
      </>
    )
  }

  // Every other row: the workspace opens as a FLOATING WINDOW over the Calendar (Antonio 2026-10-16), so the Calendar stays where it is and
  // the line updates itself when the stage moves. Where windows are not available it is an ordinary link (see OpenInWindowLink).
  return (
    <OpenInWindowLink
      href={row.href}
      title={`${row.name} — ${row.serviceType}`}
      aria-label={`Open workspace for ${row.name}`}
      className="whitespace-nowrap text-sm font-semibold text-blue-700 hover:underline"
    >
      Open workspace →
    </OpenInWindowLink>
  )
}
