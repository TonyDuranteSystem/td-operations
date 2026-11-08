'use client'

import { NewStoreBrowser } from '@/components/storage/new-store-browser'
import { useStoreBusy } from '@/components/accounts/store-busy'
import { CardErrorBoundary } from '@/components/dashboard/card-error-boundary'

/**
 * The Documents tab of a company or person whose files live in the NEW storage (dev job aa072623; Antonio 2026-11-07:
 * "could the folders in storage appear there like they are and with the same functionalities?" — and the 'Open in Storage' button is removed).
 *
 * It shows the Storage page's own folder screen (the right-hand side: path, folder bar, folders and files, Upload, New folder, Trash,
 * rename / move / delete, show or hide for the client with its message pop-up, right-click, ticking several files) scoped to ONE owner —
 * everything that screen does works here exactly as on the Storage page, because it IS that screen. Only the left list of all clients is missing.
 *
 * History: until 2026-10-13/14 this tab embedded the same screen; it was replaced by a button that opened Storage in a floating window
 * (so the account and the storage stayed open side by side). Nothing else needs to change for a call site: all five of them
 * (file-manager.tsx x3, contact-detail.tsx x2) go through this one component.
 *
 * `key={ownerId}` (on the crash guard, so the screen under it restarts too): the Personal / company buttons of the contact page switch the
 * owner without leaving the tab — a new owner must start from a clean screen (no open folders, ticks or half-typed names of the previous one).
 * The crash guard: a crash inside this big screen shows "Failed to load" + Retry in the tab's place instead of taking down the whole account /
 * contact page (the screen unmounting also tells the page the upload is over, so the tab buttons unlock).
 * `who` only says what to call the owner until the server has answered; the real kind comes from the server.
 * The busy signal: while an upload / group action runs, the screen tells the page (through `StoreBusyScope`) so the tab buttons stay put —
 * the same lock the Storage page has. Without a scope around it, nothing listens and nothing happens.
 */
export function StoreDocumentsPanel({ ownerId, who = 'company' }: { ownerId: string; who?: 'company' | 'person' }) {
  const { setBusy } = useStoreBusy()
  return (
    <CardErrorBoundary key={ownerId} fallbackTitle="Documents">
      <NewStoreBrowser ownerId={ownerId} scopedKind={who === 'person' ? 'person' : 'company'} onBusyChange={setBusy} />
    </CardErrorBoundary>
  )
}
