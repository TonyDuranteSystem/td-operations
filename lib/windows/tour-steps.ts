/**
 * The guided tour of floating windows — what it says and when each step counts as done (dev job f3f3e237).
 *
 * Everything that can be decided without a screen lives here, pure and unit-tested (R086): the plain-English
 * copy, the key names for this person's computer, whether a step is finished, and what to do when a step can't
 * run (three windows already open, the practice window closed, …). The component only draws it.
 *
 * Design rules that came out of the reviews (UX designer, bug hunter, system counselor, 2026-10-06):
 *  - the tour never lies about progress — a step is done only when the real thing happened, and the only way
 *    past an unfinished step is "Skip this step";
 *  - it never closes a window it did not see the person open;
 *  - practice only on Accounts and Leads (Portal Chats / Inbox mark client messages as read when opened);
 *  - pop-out and "move to the main page" are EXPLAINED, never practised (they end or replace what is on screen).
 */

import type { WindowEventDetail } from '@/lib/windows/window-events'
import type { WindowsSnapshot } from '@/lib/windows/windows-store'
import { MAX_WINDOWS } from '@/lib/windows/window-model'

/** Bump when the steps change enough that feedback from an older version would mislead. */
export const TOUR_VERSION = 1

// ───────────────────────────── this person's keys ─────────────────────────────

export type Platform = 'mac' | 'other'

export function detectPlatform(platformHint: string | undefined | null, userAgent: string | undefined | null): Platform {
  const text = `${platformHint ?? ''} ${userAgent ?? ''}`
  return /mac|iphone|ipad/i.test(text) ? 'mac' : 'other'
}

export interface KeyNames {
  /** The Option / Alt key. */
  opt: string
  /** The Command / Ctrl key. */
  cmd: string
}

export function keyNames(p: Platform): KeyNames {
  return p === 'mac' ? { opt: 'Option (⌥)', cmd: 'Command (⌘)' } : { opt: 'Alt', cmd: 'Ctrl' }
}

/** Put this person's own key names into a piece of copy. */
export function fillKeys(text: string, keys: KeyNames): string {
  return text.replace(/\{OPT\}/g, keys.opt).replace(/\{CMD\}/g, keys.cmd)
}

// ───────────────────────────── the steps ─────────────────────────────

export type StepId = 'welcome' | 'open' | 'move-resize' | 'buttons' | 'hide-restore' | 'fast-way' | 'close' | 'done'

export interface TourStep {
  id: StepId
  /** "read" steps have a Next button straight away; "act" steps wait for the person to do the thing. */
  kind: 'read' | 'act'
  title: string
  /** What it is, in plain words. */
  body: string
  /** A real situation from a staff member's day. */
  example?: string
  /** Exactly what to do. */
  tryIt?: string
  /** Shown while waiting. */
  waiting?: string
  /** Shown when done. */
  done?: string
  /** Extra plain lines (other ways, small print). */
  more?: string[]
}

export const STEPS: TourStep[] = [
  {
    id: 'welcome',
    kind: 'read',
    title: 'Open a second page without leaving the first',
    body: 'Floating windows show a CRM page on top of the page you are working on, so you can look something up without losing your place.',
    example: 'You are answering a client in Portal Chats and need their account details. Open Accounts in a window, read what you need, close it, and your chat is exactly where you left it.',
    more: [
      'This takes about 90 seconds and you will try each thing yourself. We only open pages to look at, so nothing here changes client data.',
      'Windows work on a computer screen only (about 1,000 pixels wide or more).',
    ],
  },
  {
    id: 'open',
    kind: 'act',
    title: 'Open a page in a window',
    body: 'The "Open in a window" button at the bottom of the left menu lists every page you can open this way.',
    example: 'You are in Inbox and want to check a lead. Open Leads in a window and Inbox stays exactly where it is.',
    tryIt: 'Click "Open in a window" (we circled it), then choose Accounts.',
    waiting: 'Waiting for you to open a window. Pick any page from the list.',
    done: 'Done. Accounts is open on top of your page.',
  },
  {
    id: 'move-resize',
    kind: 'act',
    title: 'Move it and change its size',
    body: 'Drag the dark bar at the top to move a window. Drag any edge or corner to change its size. Click anywhere in a window to bring it in front of the others.',
    example: 'The window is covering the client\'s name in your chat. Drag it to the side and make it a bit smaller.',
    tryIt: 'Drag the dark bar to a new spot, then drag an edge or a corner.',
    waiting: 'Waiting for you to move it and change its size.',
    done: 'Moved and resized. A window can\'t get smaller than about the size of a postcard.',
  },
  {
    id: 'buttons',
    kind: 'read',
    title: 'The buttons on the dark bar',
    body: 'Left side: the arrows go back and forward inside this window only, and your main page is not affected. The round arrow reloads it.',
    example: 'You found the right account in a window and want to work in it full size. Use the "Move to the main page" button.',
    more: [
      'Right side, from the left: Minimize hides it (next step). The arrow out of the box opens the page in a separate browser window, handy for a second monitor. "Move to the main page" closes the window and shows the page on your main screen. X closes it.',
      'Careful: "Move to the main page" is not "make bigger". It replaces the page you were on.',
      'Double-clicking the dark bar also hides the window.',
    ],
  },
  {
    id: 'hide-restore',
    kind: 'act',
    title: 'Hide it and bring it back',
    body: 'Hiding a window keeps it alive. It waits as a tab at the bottom of the screen, with anything you typed still in it.',
    example: 'You are halfway through a note in a window and a client messages you. Hide the window, answer, then bring it back.',
    tryIt: 'Click Minimize (the dash) on the dark bar. Then click the tab that appears at the bottom of the screen.',
    waiting: 'Waiting: first click Minimize on the dark bar, then click the tab at the bottom.',
    done: 'Hidden, and back.',
  },
  {
    id: 'fast-way',
    kind: 'act',
    title: 'A faster way to open one',
    body: 'Hold {OPT} and click any page in the left menu. It opens in a window instead of replacing your page.',
    example: 'You are in Portal Chats and want Leads next to it. Hold {OPT} and click Leads.',
    tryIt: 'Hold {OPT} and click Leads in the left menu.',
    waiting: 'Waiting: hold {OPT} and click Leads in the left menu.',
    done: 'Done. Leads is open in a window.',
    more: [
      'Other ways: point at a menu item and click the three dots, then "Open in a window". In search ({CMD}+K), press {CMD}+Enter on a result to open it in a window; plain Enter opens it here.',
      'No mouse? Use the "Open in a window" button with Tab and Enter.',
    ],
  },
  {
    id: 'close',
    kind: 'act',
    title: 'Close a window',
    body: 'X closes a window. If there is typing in it that has not been sent or saved, we ask before closing, so nothing is lost by accident.',
    example: 'You found the account number you needed. Close the window and you are right back in your chat.',
    tryIt: 'Click X on a window you opened in this tour.',
    waiting: 'Waiting: click X on the window.',
    done: 'Closed. Your page is exactly where you left it.',
  },
  {
    id: 'done',
    kind: 'read',
    title: 'You are set',
    body: 'A few good things to know:',
    more: [
      'Windows come back after you refresh the page or return later on this computer.',
      'Signing out clears them.',
      'Search ({CMD}+K) works while you are inside a window.',
      'You can have up to 3 at once.',
      'They only appear on a computer-size screen, not on a phone.',
      'To replay this tour: "Open in a window", then "Take the 1-minute tour".',
    ],
  },
]

export function stepIndexOf(id: StepId): number {
  return STEPS.findIndex(s => s.id === id)
}

// ───────────────────────────── progress ─────────────────────────────

/** What the person has done in the CURRENT step (reset whenever a step is entered). */
export interface StepFlags {
  moved: boolean
  resized: boolean
  minimized: boolean
  restored: boolean
  /** The page a window was opened on during this step (path + query), or null. */
  openedUrl: string | null
  closed: boolean
}

export interface TourProgress {
  stepIndex: number
  /** The window the tour practises on (the one opened in step 2, or one the person already had). */
  practiceId: string | null
  /** Ids of windows the person opened while touring — the only ones the tour may ask them to close. */
  opened: string[]
  flags: StepFlags
}

const NO_FLAGS: StepFlags = { moved: false, resized: false, minimized: false, restored: false, openedUrl: null, closed: false }

export function newProgress(): TourProgress {
  return { stepIndex: 0, practiceId: null, opened: [], flags: { ...NO_FLAGS } }
}

/** Move to a step: step-local flags start fresh, so something done earlier can't complete a later step. */
export function enterStep(p: TourProgress, index: number): TourProgress {
  const i = Math.max(0, Math.min(index, STEPS.length - 1))
  return { ...p, stepIndex: i, flags: { ...NO_FLAGS } }
}

/** Fold one thing the person did to a window into the progress. */
export function applyWindowEvent(p: TourProgress, ev: WindowEventDetail): TourProgress {
  switch (ev.type) {
    case 'opened': {
      const opened = ev.reused || p.opened.includes(ev.id) ? p.opened : [...p.opened, ev.id]
      const practiceId = p.practiceId ?? ev.id
      return { ...p, opened, practiceId, flags: { ...p.flags, openedUrl: ev.url } }
    }
    case 'moved':
      return ev.id === p.practiceId ? { ...p, flags: { ...p.flags, moved: true } } : p
    case 'resized':
      return ev.id === p.practiceId ? { ...p, flags: { ...p.flags, resized: true } } : p
    case 'minimized':
      return ev.id === p.practiceId ? { ...p, flags: { ...p.flags, minimized: true } } : p
    case 'restored':
      return ev.id === p.practiceId && p.flags.minimized ? { ...p, flags: { ...p.flags, restored: true } } : p
    case 'closed': {
      // Only a plain close of a window the person opened counts. A pop-out or "move to main page" also removes
      // the window, but that is not what this step teaches.
      const mine = p.opened.includes(ev.id) || ev.id === p.practiceId
      const practiceId = ev.id === p.practiceId ? null : p.practiceId
      return {
        ...p,
        practiceId,
        opened: p.opened.filter(x => x !== ev.id),
        flags: ev.reason === 'closed' && mine ? { ...p.flags, closed: true } : p.flags,
      }
    }
  }
}

// ───────────────────────────── is a step finished, and can it run? ─────────────────────────────

export function isStepDone(step: TourStep, p: TourProgress, snap: WindowsSnapshot): boolean {
  if (step.kind === 'read') return true
  switch (step.id) {
    case 'open':
      return p.practiceId !== null && snap.ids.includes(p.practiceId)
    case 'move-resize':
      return p.flags.moved && p.flags.resized
    case 'hide-restore':
      return p.flags.minimized && p.flags.restored
    case 'fast-way':
      return p.flags.openedUrl !== null && p.flags.openedUrl.split(/[?#]/)[0].startsWith('/leads')
    case 'close':
      return p.flags.closed
    default:
      return false
  }
}

export type Precheck =
  | { kind: 'ok' }
  /** Nothing to do, and here is why (shown to the person); `practiceId` is set when the tour picked a window. */
  | { kind: 'auto'; note: string; practiceId?: string }
  /** The step can't run right now; the person may skip it. */
  | { kind: 'blocked'; note: string }
  /** The practice window is gone: offer to open one (or, if none can be opened, to skip). */
  | { kind: 'missing'; canOpen: boolean }

/** First window that is on screen (not minimised), else the first one at all. */
function pickExisting(snap: WindowsSnapshot): string | undefined {
  return snap.ids.find(id => !snap.minimized.includes(id)) ?? snap.ids[0]
}

/** Can this step run, given the windows that exist when it is entered? */
export function precheck(step: TourStep, p: TourProgress, snap: WindowsSnapshot): Precheck {
  const practiceAlive = p.practiceId !== null && snap.ids.includes(p.practiceId)
  switch (step.id) {
    case 'open':
      if (snap.count >= MAX_WINDOWS) {
        const id = pickExisting(snap)
        return {
          kind: 'auto',
          practiceId: id,
          note: 'You already have 3 windows open, which is the most allowed. We will practice on one of them.',
        }
      }
      return { kind: 'ok' }
    case 'move-resize':
    case 'hide-restore':
      if (practiceAlive) return { kind: 'ok' }
      if (snap.count > 0) {
        const id = pickExisting(snap)
        return { kind: 'auto', practiceId: id, note: 'We will practice on a window you already have open.' }
      }
      return { kind: 'missing', canOpen: true }
    case 'fast-way':
      if (snap.count >= MAX_WINDOWS && !snap.urls.some(u => u.split(/[?#]/)[0].startsWith('/leads'))) {
        return {
          kind: 'blocked',
          note: 'You already have 3 windows open, which is the most allowed. Skip this step, or close one first.',
        }
      }
      return { kind: 'ok' }
    case 'close':
      if (snap.count === 0) return { kind: 'auto', note: 'All your windows are already closed. Nothing to do here.' }
      return { kind: 'ok' }
    default:
      return { kind: 'ok' }
  }
}

// ───────────────────────────── what to point at ─────────────────────────────

/**
 * The CSS selector of the thing the glowing ring should circle for this step right now, or null for none.
 * Windows carry `data-win-id` / `data-win-part` (see the window manager); the launcher button carries
 * `data-tour="win-launcher"`.
 */
export function ringSelector(step: TourStep, p: TourProgress, snap: WindowsSnapshot): string | null {
  const win = p.practiceId ? `[data-win-id="${p.practiceId}"]` : null
  switch (step.id) {
    case 'open':
      return '[data-tour="win-launcher"]'
    case 'move-resize':
      if (!win) return null
      // First the dark bar; once it has been moved, the whole window (for its edges and corners).
      return p.flags.moved ? win : `${win} [data-win-part="titlebar"]`
    case 'buttons':
      return win ? `${win} [data-win-part="titlebar"]` : null
    case 'hide-restore': {
      if (!win || !p.practiceId) return null
      return snap.minimized.includes(p.practiceId)
        ? `[data-win-part="tray-chip"][data-win-id="${p.practiceId}"]`
        : `${win} [data-win-part="minimize"]`
    }
    case 'fast-way':
      return 'aside a[href="/leads"]'
    case 'close': {
      const target = p.opened[p.opened.length - 1] ?? p.practiceId
      return target ? `[data-win-id="${target}"] [data-win-part="close"]` : null
    }
    default:
      return null
  }
}
