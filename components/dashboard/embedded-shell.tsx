'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { EmbeddedContext, useEmbedded } from '@/lib/embed/embedded-context'
import { useAppMode } from '@/lib/app-mode/app-mode-context'
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

/**
 * Renders its children in the normal CRM, nothing inside a window and nothing inside the TD Social app (the
 * app has its own tab bar and alerts; dev job 2072bc3e, Step 1b). Adds no DOM of its own.
 */
export function ChromeOnly({ children }: { children: React.ReactNode }) {
  const embedded = useEmbedded()
  const appMode = useAppMode()
  return embedded || appMode ? null : <>{children}</>
}

/**
 * Renders its children everywhere except inside a floating window — so it STAYS in the app. For the few
 * pieces of the frame the app still needs (today: the Supabase incident notice).
 */
export function HiddenInWindows({ children }: { children: React.ReactNode }) {
  return useEmbedded() ? null : <>{children}</>
}

/** The outer flex frame of the dashboard (same classes as before in the normal CRM). */
export function ShellFrame({ sandbox, children }: { sandbox: boolean; children: React.ReactNode }) {
  const embedded = useEmbedded()
  const appMode = useAppMode()
  // In the app the screen starts at the top: no sandbox offset (the app's own sandbox build says so itself).
  const bare = embedded || appMode
  return (
    <div
      data-sandbox={sandbox ? 'true' : undefined}
      data-embedded={embedded ? 'true' : 'false'}
      className={bare ? 'flex h-screen' : sandbox ? 'flex h-[calc(100vh-2.5rem)] mt-10' : 'flex h-screen'}
    >
      {children}
    </div>
  )
}

/**
 * The main scrolling area. Same element, same position in every mode. The top padding
 * only exists to clear the phone top bar, which a window and the app do not have.
 */
export function ShellMain({ children }: { children: React.ReactNode }) {
  const embedded = useEmbedded()
  const appMode = useAppMode()
  const bare = embedded || appMode
  return (
    // In the app the notice bar (Supabase) sits ABOVE the page instead of pushing it past the bottom of the screen: the
    // main area becomes a column and <ShellBody> below takes the rest of the height (dev job 2072bc3e, Step 1b).
    <main className={cn('flex-1 overflow-y-auto overscroll-y-contain bg-zinc-50', !bare && 'pt-14 lg:pt-0', appMode && 'flex flex-col')}>
      {children}
    </main>
  )
}

/**
 * The page itself, inside the main area. Everywhere except the TD Social app it adds nothing (no box). In the app it
 * is the part that takes the remaining height under the notice bar and scrolls on its own, so a chat's message box stays
 * on the screen whether or not a notice is showing.
 */
export function ShellBody({ children }: { children: React.ReactNode }) {
  return useAppMode() ? <div className="min-h-0 flex-1 overflow-y-auto">{children}</div> : <>{children}</>
}
