/**
 * The frame's side of a floating window (dev job f3f3e237, step 5). Installed once, by
 * EmbeddedProvider, only inside a window. Not React: it patches the frame's own history and
 * listens to its own document, and talks to the main page with plain messages
 * (lib/windows/window-messages.ts).
 *
 * WHY THE HISTORY PATCHES (council, bug hunter + system counselor): a frame's history entries are
 * part of the browser TAB's single history. Left alone, every in-window navigation would add an
 * entry the main page's Back button then steps through, and a page calling history.back() would
 * move the whole tab and destroy every window. So inside a window:
 *   - history.back() does nothing (the window's own chrome owns back / forward, from a trail the
 *     main page keeps);
 *   - pushState becomes replaceState (a navigation REPLACES the frame's entry instead of adding one).
 * Next's router calls whatever pushState / replaceState are on the page when it navigates, so this
 * covers router.push and Link clicks. Navigation the frame does on its own full-page loads is
 * unaffected (rare, and the browser's own behaviour).
 */

import {
  WIN_MSG, hasUnsentTyping, parseParentMessage,
  type FrameMessage,
} from '@/lib/windows/window-messages'

export interface WindowBridgeOptions {
  /** Show a CRM page inside this window without a full reload (the router's push). */
  navigate: (url: string) => void
}

type HistoryArgs = [data: unknown, unused: string, url?: string | URL | null]

function isTextField(el: Element): boolean {
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true
}

function fieldText(el: Element): string {
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return (el as HTMLInputElement).value ?? ''
  return el.textContent ?? ''
}

export function installWindowBridge(win: Window, options: WindowBridgeOptions): () => void {
  if (win.parent === win) return () => {} // not actually framed — nothing to talk to
  const origin = win.location.origin
  const doc = win.document
  const history = win.history

  const origBack = history.back
  const origPush = history.pushState
  const origReplace = history.replaceState

  const post = (msg: FrameMessage) => {
    try {
      win.parent.postMessage(msg, origin)
    } catch { /* the main page is gone — nothing to tell */ }
  }

  // ── where am I, what am I called ──
  let lastSent = ''
  let scheduled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const postLocation = () => {
    scheduled = false
    const url = win.location.pathname + win.location.search
    const title = doc.title || ''
    const key = `${url}\n${title}`
    if (key === lastSent) return
    lastSent = key
    post({ t: WIN_MSG, k: 'loc', url, title })
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    timer = setTimeout(postLocation, 0)
  }

  history.back = () => {}
  history.pushState = function (...args: HistoryArgs) {
    const r = origReplace.apply(history, args)
    schedule()
    return r
  }
  history.replaceState = function (...args: HistoryArgs) {
    const r = origReplace.apply(history, args)
    schedule()
    return r
  }

  // ── typing the person has not sent or saved ──
  const touched = new Set<Element>()
  const onInput = (e: Event) => {
    if (!e.isTrusted) return
    const t = e.target
    if (t instanceof Element && isTextField(t)) touched.add(t)
  }

  // ── bring this window to the front when it is used ──
  let lastFocusPost = 0
  const onUse = () => {
    const now = Date.now()
    if (now - lastFocusPost < 150) return
    lastFocusPost = now
    post({ t: WIN_MSG, k: 'focus' })
  }

  // ── shortcuts the main page owns (it has the search palette; a window does not) ──
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      post({ t: WIN_MSG, k: 'key', key: 'k' })
    }
  }

  // ── orders from the main page ──
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.parent || e.origin !== origin) return
    const msg = parseParentMessage(e.data)
    if (!msg) return
    if (msg.k === 'go') {
      options.navigate(msg.url)
    } else if (msg.k === 'ask-dirty') {
      const fields: Array<{ connected: boolean; text: string }> = []
      touched.forEach(el => {
        if (!el.isConnected) touched.delete(el)
        else fields.push({ connected: true, text: fieldText(el) })
      })
      post({ t: WIN_MSG, k: 'dirty-answer', req: msg.req, dirty: hasUnsentTyping(fields) })
    }
  }

  const titleObserver = new (win as unknown as typeof globalThis).MutationObserver(schedule)
  titleObserver.observe(doc.head ?? doc.documentElement, { subtree: true, childList: true, characterData: true })

  win.addEventListener('popstate', schedule)
  win.addEventListener('message', onMessage)
  doc.addEventListener('input', onInput, true)
  doc.addEventListener('pointerdown', onUse, true)
  doc.addEventListener('focusin', onUse, true)
  doc.addEventListener('keydown', onKey, true)

  // First report: tells the main page where this window really landed (a redirect, a sign-in page).
  schedule()

  return () => {
    if (timer) clearTimeout(timer)
    history.back = origBack
    history.pushState = origPush
    history.replaceState = origReplace
    titleObserver.disconnect()
    win.removeEventListener('popstate', schedule)
    win.removeEventListener('message', onMessage)
    doc.removeEventListener('input', onInput, true)
    doc.removeEventListener('pointerdown', onUse, true)
    doc.removeEventListener('focusin', onUse, true)
    doc.removeEventListener('keydown', onKey, true)
  }
}
