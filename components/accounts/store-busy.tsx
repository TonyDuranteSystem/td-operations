'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * "An upload / group action is running in the storage screen of this tab" — shared between the storage screen (reports it) and the page
 * around it (locks its tab buttons). Leaving the tab mid-upload would close the screen: the upload carries on without it, the page-close
 * warning is gone and a question (e.g. "a file with this name exists") would wait unseen. The Storage page does the same with its own tabs.
 * Outside a scope (any other page) the default is "never busy, nothing to tell".
 */
type StoreBusy = { busy: boolean; setBusy: (busy: boolean) => void }

const StoreBusyContext = createContext<StoreBusy>({ busy: false, setBusy: () => {} })

/** The page keeps the `busy` state (its tab buttons read it) and wraps the tab content in this. */
export function StoreBusyScope({ busy, setBusy, children }: { busy: boolean; setBusy: (busy: boolean) => void; children: ReactNode }) {
  const value = useMemo(() => ({ busy, setBusy }), [busy, setBusy])
  return <StoreBusyContext.Provider value={value}>{children}</StoreBusyContext.Provider>
}

export function useStoreBusy(): StoreBusy {
  return useContext(StoreBusyContext)
}

/** the hint shown on a tab button that is locked while an upload / group action runs in the storage screen */
export const STORE_BUSY_HINT = 'Finish or close what is running in Documents first.'
