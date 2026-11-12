'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { ReleaseNoteCard } from '@/components/releases/release-note-card'
import type { ReleaseNote } from '@/lib/release/release-notes'

/**
 * "See what's new" — opens under the update bar and describes the release BEFORE anyone refreshes (dev job 616dc839).
 * Nothing reloads while it is open: typed work is safe; Refresh is a button here, as it is on the bar. Escape closes it.
 */
export function ReleaseNotesPanel({ notes, more, onRefresh, onClose }: { notes: ReleaseNote[]; more: number; onRefresh: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="flex justify-center px-4 pb-4 pt-2" data-release-panel="">
      <div role="dialog" aria-label="What's new in this release" className="flex max-h-[calc(100vh-110px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border bg-background text-foreground shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">What&apos;s new in this release</h2>
            <p className="text-xs text-muted-foreground">Nothing changes on your screen until you press Refresh.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
          {notes.map(n => <ReleaseNoteCard key={n.id} note={n} showDay />)}
          {more > 0 && <p className="text-xs text-muted-foreground">…and {more} more older {more === 1 ? 'update' : 'updates'} — see all of them on the Releases page.</p>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          {/* a plain link in a NEW tab: this page is older than the live site, so a normal in-page navigation would reload it (and lose what is typed) */}
          <a href="/releases" target="_blank" rel="noopener" className="text-xs font-medium text-blue-600 hover:underline">All releases</a>
          <button type="button" onClick={onRefresh} className="rounded-full bg-blue-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-blue-700">Refresh now</button>
        </div>
      </div>
    </div>
  )
}
