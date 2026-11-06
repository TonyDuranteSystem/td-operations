'use client'

// Who is signed in, as the TD Talk layout (server) already knows it. TD Talk uses it to be sure a copy saved on the phone belongs to THIS person
// (lib/talk/talk-cache.ts) before showing it. `null` outside /talk (the CRM tab has no provider), where nothing is saved or shown early.
import { createContext, useContext } from 'react'

const TalkViewerContext = createContext<string | null>(null)

export function TalkViewerProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  return <TalkViewerContext.Provider value={userId}>{children}</TalkViewerContext.Provider>
}

export function useTalkViewerId(): string | null {
  return useContext(TalkViewerContext)
}
