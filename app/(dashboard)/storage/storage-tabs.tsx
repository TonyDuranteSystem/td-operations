'use client'

import { useState } from 'react'
import { StorageBrowserClient } from './storage-browser-client'
import { NewStoreBrowser } from '@/components/storage/new-store-browser'

/** Storage page tabs: today's storage, and the view of the NEW CRM store (job 685467b5). */
export function StorageTabs() {
  const [tab, setTab] = useState<'current' | 'new'>('current')
  const btn = (id: 'current' | 'new', label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
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
      </div>
      {tab === 'current' ? <StorageBrowserClient /> : <NewStoreBrowser />}
    </>
  )
}
