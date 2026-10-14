'use client'

import { ExternalLink } from 'lucide-react'
import { canOpenWindowNow, requestOpenWindow, useWindowsAvailable } from '@/lib/windows/windows-context'

/**
 * The company page for a company whose files live in the NEW storage (Drive cutover, dev job ad09ea91; Antonio 2026-10-13:
 * "work only on storage and let the documents in the account be only a read — and the Storage must open in a second floating
 * page, otherwise we go back and forth between account and storage and we need both pages open").
 *
 * The account page only READS: the list of its files (with their visible/hidden mark and a View link) sits above, and every
 * change — upload, new folder, rename, move, trash, show/hide — is done in Storage. This panel is the pointer: a button that
 * opens that company's Storage in a floating window next to this page (or, where floating windows are not available — narrow
 * screen, switch off — in a new browser tab, so the page you are working on is never replaced).
 */
export function storageLinkForOwner(ownerId: string): string {
  return `/storage?store=new&owner=${encodeURIComponent(ownerId)}`
}

export function StoreReadOnlyPanel({ ownerId, banner, who = 'company' }: { ownerId: string; banner?: React.ReactNode; who?: 'company' | 'person' }) {
  const windowsAvailable = useWindowsAvailable()
  const href = storageLinkForOwner(ownerId)
  const open = () => {
    if (canOpenWindowNow(windowsAvailable)) {
      requestOpenWindow(href, 'Storage')
      return
    }
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  return (
    <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      {banner}
      <p className="text-sm text-emerald-900">
        {who === 'person' ? "This person's documents live in the new storage." : "This company's files live in the new storage."} See, upload, rename, move
        or trash them, and show or hide a file for the client, in Storage.
      </p>
      <button
        type="button"
        onClick={open}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
      >
        <ExternalLink className="h-4 w-4" />
        Open in Storage
      </button>
    </div>
  )
}
