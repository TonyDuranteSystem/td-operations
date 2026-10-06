'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { EmbeddedContext, useEmbedded } from '@/lib/embed/embedded-context'
import { installWindowBridge } from '@/lib/embed/window-bridge'

export { useEmbedded }

/**
 * Window mode for dashboard pages (dev job f3f3e237, step 3 — the frame TEST; not the
 * final feature).
 *
 * A page loaded inside a floating window must not repeat the whole CRM around it: no
 * left menu, no alert sounds, no floating chat, no notes, no badge queries. The layout
 * (a server component) learns "I am in a frame" from the browser's first-load label —
 * but that label is only true for the FIRST load. A later refresh of the same frame is
 * labelled differently, so if the page's shape followed the server's latest answer, a
 * refresh would flip the window back into a full CRM and wipe whatever is on screen.
 *
 * So the answer is read ONCE here (useState initial value) and FROZEN for the life of
 * the document. And the tree keeps the SAME shape in both modes: each piece of chrome
 * is still rendered in its place, it just renders nothing (<ChromeOnly>), and the
 * main scrolling area always stays where it is (pull-to-refresh and many pages size
 * themselves against it). A hard navigation inside the frame is a brand-new document,
 * so it decides again from a fresh first-load label.
 */
export function EmbeddedProvider({ initial, children }: { initial: boolean; children: React.ReactNode }) {
  // Frozen: later server answers (refreshes) are ignored on purpose.
  const [embedded] = useState(initial)

  // Everything a window needs on the frame's side (dev job f3f3e237 step 5): history safety (a
  // frame's history entries are part of the BROWSER TAB's joint history, so a page's "back" would
  // step the whole tab and destroy every window), telling the main page where this window is,
  // bringing it to the front, Cmd+K, and "is there typing here that would be lost". All of it lives
  // in lib/embed/window-bridge.ts so it is one place to read and to test.
  const router = useRouter()
  useEffect(() => {
    if (!embedded) return
    return installWindowBridge(window, { navigate: url => router.push(url) })
  }, [embedded, router])

  return <EmbeddedContext.Provider value={embedded}>{children}</EmbeddedContext.Provider>
}

/** Renders its children in the normal CRM, nothing inside a window. Adds no DOM of its own. */
export function ChromeOnly({ children }: { children: React.ReactNode }) {
  return useEmbedded() ? null : <>{children}</>
}

/** The outer flex frame of the dashboard (same classes as before in the normal CRM). */
export function ShellFrame({ sandbox, children }: { sandbox: boolean; children: React.ReactNode }) {
  const embedded = useEmbedded()
  return (
    <div
      data-sandbox={sandbox ? 'true' : undefined}
      data-embedded={embedded ? 'true' : 'false'}
      className={embedded ? 'flex h-screen' : sandbox ? 'flex h-[calc(100vh-2.5rem)] mt-10' : 'flex h-screen'}
    >
      {children}
    </div>
  )
}

/**
 * The main scrolling area. Same element, same position in both modes. The top padding
 * only exists to clear the phone top bar, which a window does not have.
 */
export function ShellMain({ children }: { children: React.ReactNode }) {
  const embedded = useEmbedded()
  return (
    <main className={cn('flex-1 overflow-y-auto overscroll-y-contain bg-zinc-50', !embedded && 'pt-14 lg:pt-0')}>
      {children}
    </main>
  )
}
