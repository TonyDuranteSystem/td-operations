'use client'

import { useEffect, useState } from 'react'
import { StorageBrowserClient } from './storage-browser-client'
import { NewStoreBrowser } from '@/components/storage/new-store-browser'
import { TypeQuestionsPanel } from '@/components/storage/type-questions-panel'

const TAB_KEY = 'td-storage-tab'

/** Storage page tabs: today's storage, and the view of the NEW CRM store (job 685467b5). */
export function StorageTabs() {
  const [tab, setTab] = useState<'current' | 'new' | 'types'>('current')
  // the last tab used on this computer (a convenience only — read after the first render, never required)
  useEffect(() => {
    try { const v = window.localStorage.getItem(TAB_KEY); if (v === 'new' || v === 'types') setTab(v) } catch { /* storage blocked */ }
  }, [])
  const choose = (id: 'current' | 'new' | 'types') => {
    setTab(id)
    try { window.localStorage.setItem(TAB_KEY, id) } catch { /* storage blocked */ }
  }
  const btn = (id: 'current' | 'new' | 'types', label: string) => (
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
        {btn('current', 'Current storage')}
        {btn('new', 'New storage (pilot)')}
        {btn('types', 'Type questions')}
      </div>
      {tab === 'current' ? <StorageBrowserClient /> : tab === 'new' ? <NewStoreBrowser /> : <TypeQuestionsPanel />}
    </>
  )
}
