'use client'

import { useEffect, useState } from 'react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { NewStoreBrowser } from '@/components/storage/new-store-browser'
import { TypeQuestionsPanel } from '@/components/storage/type-questions-panel'

const TAB_KEY = 'td-storage-tab'

/** Storage page: the CRM storage (Antonio 2026-10-14: the old empty "Current storage" tab and the "pilot" label are gone) and the type questions. */
export function StorageTabs() {
  const [tab, setTab] = useState<'new' | 'types'>('new')
  // an upload / group action is running in the storage screen: leaving the tab would unmount it mid-way (and a question could wait unseen)
  const [busy, setBusy] = useState(false)
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
  const choose = (id: 'new' | 'types') => {
    if (busy && id !== tab) return
    setTab(id)
    try { window.localStorage.setItem(TAB_KEY, id) } catch { /* storage blocked */ }
  }
  const btn = (id: 'new' | 'types', label: string) => (
    <FastTooltip label={busy && tab !== id ? 'An upload is running — wait until it has finished.' : ''}>
    <button
      type="button"
      onClick={() => choose(id)}
      disabled={busy && tab !== id}
      aria-label={busy && tab !== id ? `${label} — an upload is running, wait until it has finished` : undefined}
      className={`rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${tab === id ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'}`}
    >
      {label}
    </button>
    </FastTooltip>
  )
  return (
    <>
      <div className="mb-4 flex gap-1">
        {btn('new', 'Storage')}
        {btn('types', 'Type questions')}
      </div>
      {tab === 'new' ? <NewStoreBrowser openOwnerId={deepLink?.ownerId} openFolderId={deepLink?.folderId ?? undefined} onBusyChange={setBusy} /> : <TypeQuestionsPanel />}
    </>
  )
}
