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
 *   - history.back() does not touch the tab; it asks the main page to take THIS window one step back
 *     along the trail the main page keeps (so a page's own "←" arrow works like the window's Back button);
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

// Fields where typing is "unsent text". Checkboxes, radios, sliders, file pickers and buttons are excluded:
// their value is not something a person typed and could lose.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'password', ''])

function isTextField(el: Element): boolean {
  const tag = el.tagName
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type || '').toLowerCase())
  return tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true
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
  let kind: 'push' | 'replace' | 'other' = 'other'
  let timer: ReturnType<typeof setTimeout> | undefined
  const postLocation = () => {
    scheduled = false
    const url = win.location.pathname + win.location.search
    const title = doc.title || ''
    const key = `${url}\n${title}`
    if (key === lastSent) return
    lastSent = key
    const replace = kind === 'replace'
    kind = 'other'
    post({ t: WIN_MSG, k: 'loc', url, title, replace })
  }
  const schedule = (k: 'push' | 'replace' | 'other' = 'other') => {
    // A push anywhere in the burst wins: it is a real new page even if a replace followed it.
    if (k === 'push' || (k === 'replace' && kind !== 'push')) kind = k
    if (scheduled) return
    scheduled = true
    timer = setTimeout(postLocation, 0)
  }

  // A page's own back arrow (router.back / history.back) must not move the browser TAB: ask the main page,
  // whose window Back walks this window's own trail.
  history.back = () => post({ t: WIN_MSG, k: 'back' })
  // A navigation REPLACES the frame's entry (see the header) but is still a NEW page to the window's own
  // trail, so it is reported as a push; a page tidying its own address (a real replaceState) is not.
  const ourPush = function (...args: HistoryArgs) {
    const r = origReplace.apply(history, args)
    schedule('push')
    return r
  }
  const ourReplace = function (...args: HistoryArgs) {
    const r = origReplace.apply(history, args)
    schedule('replace')
    return r
  }
  history.pushState = ourPush
  history.replaceState = ourReplace
  // go() / forward() would move the whole tab, like back() did.
  const origGo = history.go
  const origForward = history.forward
  history.go = () => {}
  history.forward = () => {}

  // ── typing the person has not sent or saved ──
  const touched = new Set<Element>()
  const onInput = (e: Event) => {
    if (!e.isTrusted) return
    const t = e.target
    if (t instanceof Element && isTextField(t)) {
      if (touched.size > 100) touched.forEach(el => { if (!el.isConnected) touched.delete(el) })
      touched.add(t)
    }
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

  const titleObserver = new (win as unknown as typeof globalThis).MutationObserver(() => schedule('other'))
  titleObserver.observe(doc.head ?? doc.documentElement, { subtree: true, childList: true, characterData: true })

  const onPop = () => schedule('other')
  win.addEventListener('popstate', onPop)
  win.addEventListener('message', onMessage)
  doc.addEventListener('input', onInput, true)
  doc.addEventListener('pointerdown', onUse, true)
  doc.addEventListener('focusin', onUse, true)
  doc.addEventListener('keydown', onKey, true)

  // First report: tells the main page where this window really landed (a redirect, a sign-in page).
  schedule('other')

  return () => {
    if (timer) clearTimeout(timer)
    // Put the originals back only if nobody has wrapped ours since (Next's router wraps these after us —
    // restoring blindly would remove ITS wrapper too).
    if (history.back !== origBack) history.back = origBack
    if (history.pushState === ourPush) history.pushState = origPush
    if (history.replaceState === ourReplace) history.replaceState = origReplace
    if (history.go !== origGo) history.go = origGo
    if (history.forward !== origForward) history.forward = origForward
    titleObserver.disconnect()
    win.removeEventListener('popstate', onPop)
    win.removeEventListener('message', onMessage)
    doc.removeEventListener('input', onInput, true)
    doc.removeEventListener('pointerdown', onUse, true)
    doc.removeEventListener('focusin', onUse, true)
    doc.removeEventListener('keydown', onKey, true)
  }
}
