'use client'

import { useEffect, useState } from 'react'
import { AppModeContext } from '@/lib/app-mode/app-mode-context'
import { applyPinchZoom } from '@/lib/app-mode/zoom'

/**
 * Wraps a layout's content for the TD Social app (dev job 2072bc3e, Step 1b).
 *
 * `initial` is the server's answer from the browser name (lib/app-mode/server.ts). It is frozen for the life
 * of the document (the browser name never changes inside one page), so a later refresh cannot flip the screen.
 *
 * The wrapper is `display: contents`: it adds NO box of its own, so every screen inside keeps exactly the
 * size and position it had without it. It only carries the `data-app-mode` marker that app-only CSS follows
 * (app/globals.css: anything with the class `app-hide` disappears inside the app) — rendered by the SERVER,
 * so there is no flash of the web-only parts before the page wakes up.
 *
 * The wrapper cannot reach what a screen draws OUTSIDE it: pop-ups, menus, tool tips, the search box, toasts and the
 * Reply window are attached to the page's own root (React portals), so the same marker is also put on the root
 * element once the page is awake (and taken off again when this layout goes away). Those things only appear after a tap,
 * so the short wait before the marker is there is never seen.
 */
export function AppModeProvider({ initial, children }: { initial: boolean; children: React.ReactNode }) {
  const [appMode] = useState(initial)
  useEffect(() => {
    if (!appMode) return
    const root = document.documentElement
    root.setAttribute('data-app-mode', 'true')
    return () => root.removeAttribute('data-app-mode')
  }, [appMode])
  // Pinch-zoom is allowed inside the app (the pages' own "no zoom" setting is rewritten). Next puts the page's setting back when it changes
  // page, so the head is watched and the rewrite is applied again; applying it twice changes nothing, so this cannot loop.
  useEffect(() => {
    if (!appMode) return
    applyPinchZoom(document)
    const watcher = new MutationObserver(() => { applyPinchZoom(document) })
    watcher.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] })
    return () => watcher.disconnect()
  }, [appMode])
  return (
    <AppModeContext.Provider value={appMode}>
      <div data-app-mode={appMode ? 'true' : undefined} className="contents">{children}</div>
    </AppModeContext.Provider>
  )
}
