'use client'

import { useEffect, useState } from 'react'
import { NewStoreBrowser } from '@/components/storage/new-store-browser'
import { TypeQuestionsPanel } from '@/components/storage/type-questions-panel'
import { DriveGapPanel } from '@/components/storage/drive-gap-panel'

const TAB_KEY = 'td-storage-tab'

/** Storage page: the CRM storage (Antonio 2026-10-14: the old empty "Current storage" tab and the "pilot" label are gone) and the type questions. */
export function StorageTabs({ showDriveCheck = false }: { showDriveCheck?: boolean }) {
  const [tab, setTab] = useState<'new' | 'types' | 'drive'>('new')
  // a link can open the NEW storage on one folder: /storage?store=new&owner=<id>&folder=<id>
  const [deepLink, setDeepLink] = useState<{ ownerId: string; folderId: string | null } | null>(null)
  // the last tab used on this computer (a convenience only — read after the first render, never required)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const owner = q.get('owner')
    const folder = q.get('folder')
    if (q.get('store') === 'new' && owner) {
      // with a folder: that folder; without one: the company's storage from the top (the company page's "Open in Storage")
      setDeepLink({ ownerId: owner, folderId: folder })
      setTab('new')
      return
    }
    try { const v = window.localStorage.getItem(TAB_KEY); if (v === 'types') setTab(v) } catch { /* storage blocked */ }
  }, [])
  const choose = (id: 'new' | 'types' | 'drive') => {
    setTab(id)
    try { window.localStorage.setItem(TAB_KEY, id) } catch { /* storage blocked */ }
  }
  const btn = (id: 'new' | 'types' | 'drive', label: string) => (
    <button
      type="button"
      onClick={() => choose(id)}
      className={`rounded-md px-3 py-1.5 text-sm ${tab === id ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'}`}
    >
      {label}
    </button>
  )
  return (
    <>
      <div className="mb-4 flex gap-1">
        {btn('new', 'Storage')}
        {btn('types', 'Type questions')}
        {showDriveCheck && btn('drive', 'Drive check')}
      </div>
      {tab === 'new' ? <NewStoreBrowser openOwnerId={deepLink?.ownerId} openFolderId={deepLink?.folderId ?? undefined} /> : tab === 'types' ? <TypeQuestionsPanel /> : showDriveCheck ? <DriveGapPanel /> : null}
    </>
  )
}
